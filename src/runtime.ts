import type { McpInvocationMeta, ModuleHostApi, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { errorText, requireFact } from './errors.ts';
import { Ingestion } from './ingestion.ts';
import { AssistantService, questionKey } from './service.ts';
import type { Binding, Delivery, Reception, Role } from './types.ts';
import { bindingSchema, createSessionSchema, enrollSchema } from './schema.ts';

export interface HistoryPage {
  events: NativeChatEvent[];
  cursor: string | null;
  liveCursor?: string | null;
  cursorStatus: string;
  hasMore: boolean;
}
export interface NativeAccess {
  host: ModuleHostApi;
  read(sessionId: string, cursor: string | null, bootstrap: boolean, backward?: boolean): Promise<HistoryPage>;
  answer(sessionId: string, requestId: string, answer: string, wasFreeform: boolean): Promise<{ accepted: boolean; result: unknown }>;
}
const tools: Record<Role, string[]> = {
  coordinator: ['assistant_read', 'assistant_claim', 'assistant_decide'],
  memory: ['assistant_read', 'assistant_claim', 'assistant_remember'],
};

export class Runtime {
  readonly ingestion: Ingestion;
  private sessions = new Set<string>();
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly service: AssistantService, readonly native: NativeAccess,
    readonly report: (error: unknown) => void, readonly notify: () => void) {
    this.ingestion = new Ingestion(service);
  }
  async start(): Promise<void> {
    this.service.recover();
    for (const binding of this.service.db.find('bindings', () => true)) {
      try { await this.verifyBinding(binding); } catch (error) { this.problem(`role:${binding.id}`, error); }
    }
    for (const reception of this.service.db.find('receptions', r => r.enabled)) this.sessions.add(reception.id);
    await this.wake();
  }
  stop(): void {
    this.stopped = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
  }
  async settled(): Promise<void> { await this.running; }
  wake(sessionId?: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (sessionId && this.service.db.get('receptions', sessionId)?.enabled) this.sessions.add(sessionId);
    this.again = true;
    if (!this.running) {
      this.running = this.pump().finally(() => { this.running = null; });
    }
    return this.running;
  }
  private async pump(): Promise<void> {
    while (this.again && !this.stopped) {
      this.again = false;
      const ids = [...this.sessions];
      this.sessions.clear();
      for (const id of ids) {
        if (this.stopped) return;
        try { await this.consume(id); } catch (error) { this.problem(`reception:${id}`, error); }
      }
      this.queueWorkers();
      for (const delivery of this.service.db.find('deliveries', d => d.state === 'pending')) {
        if (this.stopped) return;
        await this.send(delivery.id);
      }
      try { this.notify(); } catch (error) { this.report(error); }
    }
    this.armLeaseExpiry();
  }
  private armLeaseExpiry(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    if (this.stopped) return;
    const deadlines = this.service.db.find('work', w => w.state === 'leased'
      && w.leaseUntil > this.service.now()).map(w => w.leaseUntil);
    if (!deadlines.length) return;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      void this.wake().catch(this.report);
    }, Math.max(1, Math.min(...deadlines) - this.service.now()));
    this.leaseTimer.unref();
  }
  private problem(key: string, error: unknown): void {
    this.service.db.transaction(() => {
      this.service.db.setMeta(`error:${key}`, errorText(error));
      this.service.publish({ type: 'status', text: `${key}: ${errorText(error)}` });
    });
    this.report(error);
  }
  private async meta(sessionId: string): Promise<PublicSessionMeta | null> {
    return (await this.native.host.call('session/get', { sessionId })).meta;
  }
  async enroll(input: unknown): Promise<unknown> {
    const value = enrollSchema.parse(input);
    const key = `enroll:${value.requestId}`;
    const prior = this.service.db.get('operations', key);
    if (prior) {
      requireFact(prior.fingerprint === fingerprint(value), 'IDEMPOTENCY_CONFLICT', 'Enrollment request changed');
      return prior.result;
    }
    const meta = await this.meta(value.sessionId);
    requireFact(meta, 'SESSION_MISSING', 'Explicit reception session does not exist', 404);
    return this.service.db.transaction(() => this.service.idempotent(key, value, () => {
      const db = this.service.db;
      requireFact(!db.find('bindings', b => b.sessionId === value.sessionId).length,
        'INTERNAL_TARGET', 'Internal role session cannot enroll as a reception');
      requireFact(!db.get('receptions', value.sessionId), 'ALREADY_ENROLLED', 'Use reception management for an existing enrollment');
      requireFact(db.find('receptions', r => r.enabled).length < this.service.config.maxReceptions,
        'RECEPTION_LIMIT', 'Configured reception limit reached');
      const reception: Reception = {
        id: value.sessionId, label: value.label, kind: value.kind, enabled: true,
        evidence: value.evidence, availability: meta.loaded ? 'loaded' : 'unloaded',
        cursor: null, cursorSource: 'live', cursorDirection: 'forward', baseline: false,
        gap: null, generation: 1, version: 1,
      };
      db.put('receptions', reception);
      this.service.changed();
      this.sessions.add(reception.id);
      return reception;
    }));
  }
  async consume(sessionId: string): Promise<void> {
    const { db } = this.service;
    const reception = db.get('receptions', sessionId);
    if (!reception?.enabled) return;
    const meta = await this.meta(sessionId);
    if (this.stopped) return;
    db.transaction(() => {
      const current = db.must('receptions', sessionId);
      requireFact(current.generation === reception.generation, 'STALE_READER', 'Enrollment changed during native read');
      current.availability = !meta ? 'missing' : meta.loaded ? 'loaded' : 'unloaded';
      db.put('receptions', current);
      if (current.kind === 'reception') {
        const asks = meta?.decisions?.filter(d => d.kind === 'ask').map(d => d.request) ?? (meta?.ask ? [meta.ask] : []);
        this.service.syncQuestions(sessionId, asks, !!meta?.loaded);
      }
    });
    if (!meta?.loaded || reception.gap) return;
    if (!reception.baseline) {
      const page = await this.native.read(sessionId, null, true);
      if (this.stopped) return;
      requireFact(typeof page.liveCursor === 'string', 'NO_LIVE_CURSOR', 'Native bootstrap returned no continuation cursor');
      db.transaction(() => {
        this.ingestion.applyWithinTransaction(sessionId, reception.generation, page.events, page.liveCursor!, true, false);
        const current = db.must('receptions', sessionId);
        requireFact(current.generation === reception.generation, 'STALE_READER', 'Enrollment changed during bootstrap');
        current.baseline = true;
        current.cursor = page.liveCursor!;
        db.put('receptions', current);
      });
    }
    for (let count = 0; count < 16; count++) {
      const current = db.must('receptions', sessionId);
      const page = await this.native.read(sessionId, current.cursor, false);
      if (this.stopped) return;
      if (page.cursorStatus === 'expired') {
        db.transaction(() => {
          const latest = db.must('receptions', sessionId);
          latest.gap = 'Native cursor expired; explicit gap acknowledgment and resynchronization required.';
          db.put('receptions', latest);
          this.service.publish({ type: 'status', text: `${sessionId}: ${latest.gap}` });
        });
        return;
      }
      requireFact(typeof page.cursor === 'string', 'NO_CURSOR', 'Native read did not return a usable cursor');
      this.ingestion.apply(sessionId, reception.generation, page.events, page.cursor);
      if (!page.hasMore) return;
    }
    this.sessions.add(sessionId);
    this.again = true;
  }
  async recoverHistory(sessionId: string, requestId: string, maxPages: number, evidence: string): Promise<unknown> {
    requireFact(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 10 && evidence.trim(),
      'RECOVERY_INPUT', 'Recovery needs 1..10 pages and explicit gap-acknowledgment evidence', 400);
    const { db } = this.service;
    const reception = this.service.reception(sessionId, true);
    const key = `history-recovery:${requestId}`;
    const input = { sessionId, maxPages, evidence };
    const existing = db.get('operations', key);
    if (existing) {
      requireFact(existing.fingerprint === fingerprint(input), 'IDEMPOTENCY_CONFLICT', 'History recovery request changed');
      return existing;
    }
    let cursor: string | null = null;
    let liveCursor: string | null = null;
    let hasMore = true;
    let pages = 0;
    db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(input),
      state: 'calling', result: { sessionId, pages, evidence } }));
    try {
      requireFact((await this.meta(sessionId))?.loaded, 'SESSION_UNAVAILABLE', 'Load the original native session before recovery');
      while (pages < maxPages && hasMore) {
        const page = await this.native.read(sessionId, cursor, pages === 0, true);
        requireFact(!this.stopped, 'STOPPING', 'Runtime stopped during recovery');
        requireFact(page.cursorStatus !== 'expired' && typeof page.cursor === 'string',
          'RECOVERY_CURSOR', 'Recovery cursor expired or is unavailable; no forward position was changed');
        if (pages === 0) {
          requireFact(typeof page.liveCursor === 'string', 'NO_LIVE_CURSOR', 'Recovery requires a live bootstrap cursor');
          liveCursor = page.liveCursor;
        }
        db.transaction(() => {
          this.ingestion.applyWithinTransaction(sessionId, reception.generation, page.events, page.cursor!, true, false);
          cursor = page.cursor;
          hasMore = page.hasMore;
          pages++;
          db.put('operations', { id: key, fingerprint: fingerprint(input), state: 'calling',
            result: { sessionId, pages, backwardCursor: cursor, liveCursor, evidence } });
        });
      }
      return db.transaction(() => {
        const current = db.must('receptions', sessionId);
        requireFact(current.generation === reception.generation, 'STALE_READER', 'Enrollment changed during recovery');
        current.cursor = liveCursor;
        current.baseline = true;
        current.gap = null;
        current.generation++;
        db.put('receptions', current);
        const result = { sessionId, pages, historical: true, olderHistoryRemaining: hasMore,
          backwardCursor: cursor, liveCursor, evidence,
          warning: 'Bounded historical recovery is not proof of gap-free history; imported outputs are not published as new replies.' };
        this.service.publish({ type: 'status', text: result.warning });
        this.service.changed();
        db.put('operations', { id: key, fingerprint: fingerprint(input), state: 'accepted', result });
        return result;
      });
    } catch (error) {
      db.transaction(() => {
        const operation = db.must('operations', key);
        operation.state = 'unknown';
        operation.result = { progress: operation.result, error: errorText(error),
          warning: 'Imported pages may persist. The forward cursor was not replaced; use an explicit new recovery operation after inspection.' };
        db.put('operations', operation);
      });
      throw error;
    }
  }
  async verifyBinding(binding: Binding): Promise<Binding> {
    const meta = await this.meta(binding.sessionId);
    requireFact(meta?.loaded && meta.currentModelId === binding.modelId && meta.cwd === binding.cwd,
      'ROLE_CONFIGURATION', 'Role is unloaded or its native model/directory changed');
    const readiness = await this.native.host.call('roles/readiness', { sessionId: binding.sessionId,
      roles: [{ moduleId: 'assistant', roleId: binding.id }] });
    requireFact(readiness.ready && readiness.loaded && !readiness.rolesNeedReload
      && readiness.appliedRoles?.some(r => r.moduleId === 'assistant' && r.roleId === binding.id),
    'ROLE_NOT_READY', 'Role capability or applied role assembly is not confirmed');
    return this.service.db.transaction(() => {
      const current = this.service.db.must('bindings', binding.id);
      requireFact(current.epoch === binding.epoch && current.sessionId === binding.sessionId,
        'STALE_ROLE', 'Role changed during native readiness read');
      current.ready = true;
      current.evidence = { readiness, modelId: meta.currentModelId, checkedAt: this.service.now() };
      this.service.db.put('bindings', current);
      return current;
    });
  }
  async authorize(identity: McpInvocationMeta, role: Role, epoch: number): Promise<void> {
    const binding = this.service.authorize(identity, role, epoch);
    try { await this.verifyBinding(binding); }
    catch (error) {
      this.service.db.transaction(() => {
        const current = this.service.db.must('bindings', role);
        if (current.epoch === epoch) { current.ready = false; this.service.db.put('bindings', current); }
      });
      throw error;
    }
  }
  async bind(input: unknown): Promise<unknown> {
    const value = bindingSchema.parse(input);
    const key = `bind:${value.requestId}`;
    const existing = this.service.db.get('operations', key);
    if (existing) {
      requireFact(existing.fingerprint === fingerprint(value), 'IDEMPOTENCY_CONFLICT', 'Role binding request changed');
      return existing;
    }
    const { db } = this.service;
    db.transaction(() => {
      requireFact((db.get('bindings', value.role)?.epoch ?? 0) === value.expectedEpoch, 'STALE_ROLE', 'Role epoch changed');
      requireFact(!db.get('receptions', value.sessionId), 'RECEPTION_TARGET', 'Reception cannot become an internal role');
      requireFact(!db.find('bindings', b => b.id !== value.role && b.sessionId === value.sessionId).length,
        'ROLE_CONFLICT', 'One native session cannot carry both internal roles');
      db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'calling', result: null });
    });
    let result: unknown;
    try {
      const meta = await this.meta(value.sessionId);
      requireFact(meta?.loaded && meta.currentModelId === value.expectedModelId,
        'ROLE_CONFIGURATION', 'Expected model and loaded role session are required');
      requireFact(this.native.host.resourcePreparationVersion === 1, 'HOST_CAPABILITY', 'Host resource preparation is required');
      const preparation = await this.native.host.call('session/resources-prepare', {
        sessionId: value.sessionId, mcpServers: [{ name: 'assistant', tools: tools[value.role] }],
      });
      requireFact(preparation.ok, 'PREPARATION_FAILED', preparation.error ?? 'Native role resource preparation failed');
      const readiness = await this.native.host.call('roles/readiness', { sessionId: value.sessionId,
        roles: [{ moduleId: 'assistant', roleId: value.role }] });
      requireFact(readiness.ready && readiness.appliedRoles?.some(r => r.moduleId === 'assistant' && r.roleId === value.role),
        'ROLE_NOT_READY', 'Candidate has not applied the required ready role');
      requireFact(!this.stopped, 'STOPPING', 'Runtime stopped before role cutover');
      result = db.transaction(() => {
        requireFact((db.get('bindings', value.role)?.epoch ?? 0) === value.expectedEpoch, 'STALE_ROLE', 'Concurrent role replacement won');
        requireFact(!db.get('receptions', value.sessionId)
          && !db.find('bindings', b => b.id !== value.role && b.sessionId === value.sessionId).length,
        'ROLE_CONFLICT', 'Candidate was enrolled or assigned another role during preparation');
        const previousSession = db.get('bindings', value.role)?.sessionId;
        const binding: Binding = { id: value.role, sessionId: value.sessionId, epoch: value.expectedEpoch + 1,
          definitionVersion: value.definitionVersion, modelId: value.expectedModelId, cwd: meta.cwd,
          ready: true, evidence: { preparation, readiness } };
        db.put('bindings', binding);
        for (const work of db.find('work', w => w.role === value.role && w.state === 'leased')) {
          work.state = 'pending'; work.epoch = null; work.token = null; work.leaseUntil = 0;
          db.put('work', work);
        }
        for (const delivery of db.find('deliveries', d => d.kind === 'wake' && d.sessionId === previousSession
          && d.roleEpoch === value.expectedEpoch && d.state === 'pending')) {
          delivery.state = 'cancelled'; db.put('deliveries', delivery);
        }
        db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'accepted', result: binding });
        this.service.changed();
        return binding;
      });
    } catch (error) {
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value),
        state: 'unknown', result: { error: errorText(error), warning: 'Preparation may have applied; inspect native state before a new operation.' } }));
      throw error;
    }
    return result;
  }
  async create(input: unknown): Promise<unknown> {
    const value = createSessionSchema.parse(input);
    const key = `create:${value.requestId}`;
    const db = this.service.db;
    const existing = db.get('operations', key);
    if (existing) {
      requireFact(existing.fingerprint === fingerprint(value), 'IDEMPOTENCY_CONFLICT', 'Creation request changed');
      return existing;
    }
    db.transaction(() => {
      requireFact(db.find('operations', op => op.id.startsWith('create:') && op.state === 'unknown').length === 0,
        'UNRESOLVED_CREATE', 'Resolve uncertain native creation before creating another session');
      db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'calling', result: null });
    });
    try {
      const result = await this.native.host.call('session/new', { cwd: value.cwd,
        ...(value.role ? { roles: [{ moduleId: 'assistant', roleId: value.role }] } : {}) });
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'accepted', result }));
      return result;
    } catch (error) {
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'unknown',
        result: { error: errorText(error) } }));
      throw error;
    }
  }
  private queueWorkers(): void {
    const db = this.service.db;
    db.transaction(() => {
      for (const binding of db.find('bindings', b => b.ready)) {
        const pending = db.find('work', w => w.role === binding.id && (w.state === 'pending'
          || w.state === 'leased' && w.leaseUntil <= this.service.now()));
        if (!pending.length) continue;
        const key = fingerprint([binding.id, binding.epoch, pending.map(w => [w.id, w.inputVersion,
          w.state === 'leased' ? w.leaseUntil : 0])]);
        const unresolved = db.find('deliveries', d => d.kind === 'wake' && d.sessionId === binding.sessionId
          && d.roleEpoch === binding.epoch && (d.state === 'unknown' || d.state === 'calling'));
        if (unresolved.length) continue;
        if (db.get('deliveries', `wake:${key}`)) continue;
        db.put('deliveries', { id: `wake:${key}`, kind: 'wake', messageId: null, sessionId: binding.sessionId,
          requestId: null, text: `Assistant durable work is available. Role=${binding.id}, epoch=${binding.epoch}. `
            + 'Use assistant_claim, read its input and current state, then submit through the role tool. '
            + 'Drain pending work. This is an internal wake, not user authorization or a public reply.',
          supplement: null, answerFreeform: null, state: 'pending', result: null, error: null,
          createdAt: this.service.now(), roleEpoch: binding.epoch });
      }
    });
  }
  private async send(id: string): Promise<void> {
    const db = this.service.db;
    let delivery = db.must('deliveries', id);
    if (delivery.state !== 'pending') return;
    try {
      const meta = await this.meta(delivery.sessionId);
      requireFact(meta?.loaded && !meta.closing, 'SESSION_UNAVAILABLE', 'Native target is missing, unloaded, or closing');
      if (delivery.kind === 'wake') {
        const binding = db.find('bindings', b => b.sessionId === delivery.sessionId && b.epoch === delivery.roleEpoch)[0];
        requireFact(binding, 'STALE_ROLE', 'Wake belongs to a retired role epoch');
        await this.verifyBinding(binding);
      } else {
        this.service.reception(delivery.sessionId);
        if (delivery.kind === 'ask') {
          const asks = meta.decisions?.filter(d => d.kind === 'ask').map(d => d.request) ?? (meta.ask ? [meta.ask] : []);
          const ask = asks.find(q => q.requestId === delivery.requestId);
          const stored = db.must('questions', questionKey(delivery.sessionId, delivery.requestId!));
          requireFact(ask && stored.state === 'pending' && fingerprint(ask) === fingerprint(stored.request),
            'STALE_ASK', 'The exact original native question is no longer pending');
        }
      }
    } catch (error) {
      db.transaction(() => {
        delivery = db.must('deliveries', id);
        if (delivery.state !== 'pending') return;
        delivery.state = 'rejected'; delivery.error = errorText(error);
        db.put('deliveries', delivery);
        this.service.publish({ type: 'status', messageId: delivery.messageId, text: delivery.error });
      });
      return;
    }
    if (this.stopped) return;
    db.transaction(() => {
      delivery = db.must('deliveries', id);
      requireFact(delivery.state === 'pending', 'EFFECT_CHANGED', 'Effect changed before native call');
      if (delivery.kind === 'wake') {
        requireFact(db.find('bindings', b => b.sessionId === delivery.sessionId && b.epoch === delivery.roleEpoch && b.ready).length === 1,
          'STALE_ROLE', 'Role was replaced immediately before wake dispatch');
      } else this.service.reception(delivery.sessionId);
      delivery.state = 'calling';
      db.put('deliveries', delivery);
    });
    let state: Delivery['state'];
    let result: unknown;
    let error: string | null = null;
    try {
      if (delivery.kind === 'ask') {
        const response = await this.native.answer(delivery.sessionId, delivery.requestId!, delivery.text, delivery.answerFreeform!);
        result = response.result;
        state = response.accepted ? 'accepted' : 'rejected';
      } else {
        result = await this.native.host.call('prompt', { sessionId: delivery.sessionId, mode: 'enqueue',
          text: delivery.supplement ? `${delivery.text}\n\n---\n${delivery.supplement}` : delivery.text });
        state = typeof result === 'object' && result !== null && 'ok' in result && result.ok === true ? 'accepted' : 'rejected';
      }
    } catch (failure) {
      state = 'unknown'; result = null; error = errorText(failure);
    }
    db.transaction(() => {
      delivery.state = state; delivery.result = result; delivery.error = error;
      db.put('deliveries', delivery);
      if (delivery.kind === 'ask') {
        const question = db.must('questions', questionKey(delivery.sessionId, delivery.requestId!));
        if (state === 'accepted') question.state = 'answered';
        if (state === 'unknown') question.state = 'unknown';
        db.put('questions', question);
      }
      this.service.publish({ type: 'status', messageId: delivery.messageId,
        text: `Native ${delivery.kind} ${state}${error ? `: ${error}` : ''}. Acceptance is not proof the model read it.` });
    });
  }
}

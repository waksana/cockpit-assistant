import type { McpInvocationMeta, ModuleHostApi, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint } from './database.ts';
import { BusinessError, errorText, requireFact } from './errors.ts';
import { Ingestion, primary } from './ingestion.ts';
import { AssistantService, askAnswer, questionKey } from './service.ts';
import type { Batch, Binding, Delivery, Operation, Reception, Role } from './types.ts';
import { activateRolesSchema, bindingSchema, createSessionSchema, enrollSchema, inputSchema } from './schema.ts';
import type { Readiness, RoleReadiness, SessionInspection } from './ui-types.ts';
import { ensureTopicSession } from './topic-session.ts';

export interface HistoryPage {
  events: NativeChatEvent[];
  cursor: string | null;
  liveCursor?: string | null;
  cursorStatus: string;
  hasMore: boolean;
}
export interface NativeAccess {
  host: ModuleHostApi;
  read(sessionId: string, cursor: string | null, bootstrap: boolean, backward?: boolean, all?: boolean): Promise<HistoryPage>;
  answer(sessionId: string, requestId: string, answer: string, wasFreeform: boolean): Promise<{ accepted: boolean; result: unknown }>;
}
const tools: Record<Role, string[]> = {
  coordinator: ['assistant_topics', 'assistant_topic', 'assistant_map', 'assistant_sessions',
    'assistant_history', 'assistant_dispatch', 'assistant_attribute', 'assistant_clarify'],
  memory: ['assistant_memory_read', 'assistant_memory_claim', 'assistant_remember'],
};

interface ConsumerRead {
  cursor: string;
}
class SessionMetadataPending extends BusinessError {
  constructor(readonly sessionId: string) {
    super('SESSION_TRANSITION', 'Native session metadata is pending during a lifecycle transition');
  }
}

export class Runtime {
  readonly ingestion: Ingestion;
  private sessions = new Set<string>();
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private liveEvents = new Map<string, Set<string>>();
  private consumerReads = new Map<string, Promise<void>>();
  private receiptWaiters = new Map<string, Set<() => void>>();
  constructor(readonly service: AssistantService, readonly native: NativeAccess,
    readonly report: (error: unknown) => void, readonly notify: () => void) {
    this.ingestion = new Ingestion(service);
  }
  async start(): Promise<void> {
    this.service.recover();
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const page = await this.native.host.call('session/directory', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (this.stopped) return;
      for (const session of page.sessions) {
        try { await this.observe(session.sessionId); }
        catch (error) { this.problem(`reception:${session.sessionId}`, error); }
        if (this.stopped) return;
        this.sessions.add(session.sessionId);
      }
      cursor = page.cursor;
      if (cursor) {
        requireFact(!visited.has(cursor), 'DIRECTORY_CURSOR', 'Session directory cursor did not advance');
        visited.add(cursor);
      }
    } while (cursor);
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
    for (const waiters of this.receiptWaiters.values()) for (const done of waiters) done();
    this.receiptWaiters.clear();
  }
  async settled(): Promise<void> { await this.running; }
  wake(sessionId?: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (sessionId) this.sessions.add(sessionId);
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
        try {
          await this.observe(id);
          for (const binding of this.service.db.find('bindings', binding => binding.sessionId === id)) {
            try { await this.verifyBinding(binding); }
            catch (error) { this.problem(`role:${binding.id}`, error); }
          }
          await this.consume(id);
        } catch (error) { this.problem(`reception:${id}`, error); }
      }
      if (this.stopped) return;
      await this.queueWorkers();
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
    const deadlines = this.service.db.find('work', w => w.role === 'memory' && w.state === 'leased'
      && w.leaseUntil > this.service.now()).map(w => w.leaseUntil);
    deadlines.push(...this.service.db.find('deliveries', d => d.state === 'pending'
      && (d.preparation?.nextAttemptAt ?? 0) > 0).map(d => d.preparation!.nextAttemptAt));
    deadlines.push(...this.service.db.find('work', work => work.state === 'pending'
      && (work.retryAfter ?? 0) > 0).map(work => work.retryAfter!));
    if (!deadlines.length) return;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      void this.wake().catch(this.report);
    }, Math.max(1, Math.min(...deadlines) - this.service.now()));
    this.leaseTimer.unref();
  }
  private problem(key: string, error: unknown): void {
    if (error instanceof SessionMetadataPending
      || this.stopped && error instanceof BusinessError && error.code === 'STOPPING') return;
    this.service.db.transaction(() => {
      this.service.db.setMeta(`error:${key}`, errorText(error));
      this.service.publish({ type: 'status', text: `${key}: ${errorText(error)}` });
    });
    this.report(error);
  }
  private async meta(sessionId: string): Promise<PublicSessionMeta | null> {
    const { db } = this.service;
    const key = `metadata:${sessionId}`;
    for (let attempt = 0; ; attempt++) {
      requireFact(!this.stopped, 'STOPPING', 'Assistant stopped during metadata observation');
      let meta: PublicSessionMeta | null;
      try {
        meta = (await this.native.host.call('session/get', { sessionId })).meta;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'SESSION_TRANSITION') throw error;
        const pending = new SessionMetadataPending(sessionId);
        db.transaction(() => {
          if (!db.meta(key, null))
            this.service.publish({ type: 'status', text: `${sessionId}: ${pending.message}` });
          db.setMeta(key, { state: 'pending', attempts: attempt + 1, exhausted: attempt === 2 });
          for (const binding of db.find('bindings', item => item.sessionId === sessionId)) {
            binding.ready = false;
            binding.evidence = { pending: true, code: pending.code, detail: pending.message, checkedAt: this.service.now() };
            db.put('bindings', binding);
          }
        });
        if (attempt === 2) throw pending;
        await delay(attempt === 0 ? 50 : 150);
        continue;
      }
      requireFact(!meta || meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned a different session');
      if (db.meta(key, null)) db.transaction(() => {
        db.setMeta(key, null);
        this.service.publish({ type: 'status', text: `${sessionId}: Native session metadata observation recovered.` });
      });
      return meta;
    }
  }
  private internal(meta: PublicSessionMeta): boolean {
    return [...(meta.roles ?? []), ...(meta.appliedRoles ?? [])].some(item =>
      item.moduleId === 'assistant' && (item.roleId === 'coordinator' || item.roleId === 'memory'))
      || this.service.db.find('bindings', binding => binding.sessionId === meta.sessionId).length > 0;
  }
  noteEvent(sessionId: string, event: NativeChatEvent): void {
    if (event.type !== 'assistant.message' || event.ephemeral || !primary(event)
      || this.service.db.get('receptions', sessionId)?.baseline) return;
    const events = this.liveEvents.get(sessionId) ?? new Set<string>();
    events.add(event.id);
    this.liveEvents.set(sessionId, events);
  }
  private async stillOrdinary(sessionId: string): Promise<boolean> {
    const meta = await this.meta(sessionId);
    if (this.stopped) return false;
    requireFact(!meta || meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned a different session');
    if (!meta || this.internal(meta)) {
      await this.observe(sessionId);
      return false;
    }
    return true;
  }
  async observe(sessionId: string): Promise<void> {
    const meta = await this.meta(sessionId);
    requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before session observation');
    requireFact(!meta || meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned a different session');
    const excluded = meta !== null && this.internal(meta);
    const { db } = this.service;
    db.transaction(() => {
      const existing = db.get('receptions', sessionId);
      if (!meta || excluded) {
        if (existing && (existing.enabled || !meta && existing.availability !== 'missing')) {
          existing.enabled = false;
          existing.availability = meta ? meta.loaded ? 'loaded' : 'unloaded' : 'missing';
          existing.generation++;
          existing.version++;
          db.put('receptions', existing);
          this.service.syncQuestions(sessionId, [], false);
          for (const delivery of db.find('deliveries', item => item.sessionId === sessionId
            && item.kind !== 'wake' && item.state === 'pending')) {
            delivery.state = 'cancelled';
            delivery.error = excluded ? 'Target is an internal role carrier' : 'Target no longer exists';
            db.put('deliveries', delivery);
            this.service.publish({ type: 'status', messageId: delivery.messageId,
              topicId: delivery.topicId ?? null, text: delivery.error });
          }
          if (excluded) for (const work of db.find('work', item => item.state !== 'done'
            && !!item.messageId && db.get('messages', item.messageId)?.sessionId === sessionId)) {
            work.state = 'invalidated';
            db.put('work', work);
          }
          this.service.changed();
        }
        this.liveEvents.delete(sessionId);
        return;
      }
      if (!existing) {
        db.put('receptions', {
          id: sessionId, label: meta.title || sessionId, kind: 'reception', enabled: true,
          evidence: 'Public ordinary-session observation', availability: meta.loaded ? 'loaded' : 'unloaded',
          cursor: null, cursorSource: 'live', cursorDirection: 'forward', baseline: false,
          gap: null, generation: 1, version: 1,
        });
        this.service.changed();
      } else if (!existing.enabled || existing.kind !== 'reception') {
        existing.enabled = true;
        existing.kind = 'reception';
        existing.evidence = 'Public ordinary-session observation';
        existing.generation++;
        existing.version++;
        db.put('receptions', existing);
        this.service.changed();
      }
    });
  }
  async inspect(sessionId: string): Promise<SessionInspection> {
    const meta = await this.meta(sessionId);
    requireFact(meta, 'SESSION_MISSING', 'Explicit session does not exist', 404);
    requireFact(meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned a different session');
    return { sessionId, modelId: meta.currentModelId ?? null, cwd: meta.cwd,
      loaded: meta.loaded, status: meta.status, rolesNeedReload: meta.rolesNeedReload ?? null };
  }
  async activateRoles(input: unknown): Promise<Operation> {
    const value = activateRolesSchema.parse(input);
    const { db } = this.service;
    const key = `activate:${value.requestId}`;
    const prior = db.get('operations', key);
    if (prior) {
      requireFact(prior.fingerprint === fingerprint(value), 'IDEMPOTENCY_CONFLICT', 'Activation request changed');
      return prior;
    }
    const matches = (): void => {
      const actual = db.find('bindings', () => true).map(binding =>
        ({ role: binding.id, sessionId: binding.sessionId, epoch: binding.epoch })).sort((a, b) => a.role.localeCompare(b.role));
      requireFact(fingerprint(actual) === fingerprint([...value.bindings].sort((a, b) => a.role.localeCompare(b.role))),
        'STALE_ROLE', 'Registered carriers changed; refresh before activation');
    };
    db.transaction(() => {
      matches();
      requireFact(!db.find('operations', operation => operation.id.startsWith('activate:')
        && (operation.state === 'calling' || operation.state === 'unknown')).length,
      'UNRESOLVED_ACTIVATION', 'Inspect the outstanding role activation before starting another');
      db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'calling',
        result: { bindings: value.bindings, effects: [] } });
    });
    const effects: { role: Role; sessionId: string; effect: 'already_loaded' | 'load_accepted'; result?: unknown }[] = [];
    let mutationStarted = false;
    try {
      for (const expected of value.bindings) {
        matches();
        const meta = await this.meta(expected.sessionId);
        requireFact(meta?.sessionId === expected.sessionId, 'SESSION_MISSING', 'Registered role session no longer exists');
        requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before loading a role');
        matches();
        if (meta.loaded) effects.push({ role: expected.role, sessionId: expected.sessionId, effect: 'already_loaded' });
        else {
          mutationStarted = true;
          const result = await this.native.host.call('session/load', { sessionId: expected.sessionId });
          requireFact(result.ok === true && result.sessionId === expected.sessionId,
            'LOAD_UNCONFIRMED', 'Host did not confirm loading the registered session');
          effects.push({ role: expected.role, sessionId: expected.sessionId, effect: 'load_accepted', result });
        }
        db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'calling',
          result: { bindings: value.bindings, effects } }));
      }
      requireFact(!this.stopped, 'STOPPING', 'Assistant stopped after role loading');
      matches();
      const readiness = await this.readiness();
      matches();
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'accepted',
        result: { bindings: value.bindings, effects, readiness,
          detail: 'Loading completed; readiness is separate and no resources or already-loaded roles were repaired.' } }));
    } catch (error) {
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value),
        state: mutationStarted || !(error instanceof BusinessError) ? 'unknown' : 'rejected',
        result: { bindings: value.bindings, effects, error: errorText(error),
          detail: 'Inspect this original activation and native state before retrying; prior load effects are not rolled back.' } }));
    }
    return db.must('operations', key);
  }
  async allowRoles(sessionId: string | null, requested: readonly Role[]): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping');
    if (requested.length > 1) return { allowed: false, reason: 'coordinator and memory require separate sessions' };
    const { db } = this.service;
    for (const role of requested) {
      const binding = db.get('bindings', role);
      if (sessionId && db.find('bindings', item => item.id !== role && item.sessionId === sessionId).length) {
        return { allowed: false, reason: 'This session already carries the other internal role' };
      }
      if (!binding || binding.sessionId === sessionId) continue;
      const existing = await this.meta(binding.sessionId);
      requireFact(!this.stopped, 'STOPPING', 'Assistant stopped during role permission check');
      const current = db.get('bindings', role);
      if (current?.epoch !== binding.epoch || current.sessionId !== binding.sessionId) {
        return { allowed: false, reason: 'Role binding changed; inspect the current carrier before retrying' };
      }
      if (existing) return { allowed: false, reason: `${role} is already registered to ${binding.sessionId}` };
    }
    return { allowed: true };
  }
  async registerRoles(sessionId: string, requested: readonly Role[], requestId: string, signal?: AbortSignal): Promise<void> {
    requireFact(!this.stopped && !signal?.aborted, 'STOPPING', 'Role registration was stopped');
    const { db } = this.service;
    const input = { sessionId, roles: [...requested].sort() };
    const key = `role-registration:${requestId}`;
    const existing = db.get('operations', key);
    if (existing) {
      requireFact(existing.fingerprint === fingerprint(input), 'IDEMPOTENCY_CONFLICT', 'Role notification changed');
      await this.observe(sessionId);
      return;
    }
    const permission = await this.allowRoles(sessionId, requested);
    requireFact(permission.allowed, 'ROLE_OCCUPIED', permission.allowed ? 'Role assignment is not allowed' : permission.reason);
    const meta = await this.meta(sessionId);
    requireFact(meta?.sessionId === sessionId, 'SESSION_MISSING', 'Saved role session is not available');
    requireFact(requested.every(role => meta.roles?.some(item => item.moduleId === 'assistant' && item.roleId === role)),
      'ROLE_NOT_SAVED', 'Host role notification must match the actual saved role identities');
    requireFact(new Set(meta.roles?.filter(item => item.moduleId === 'assistant'
      && (item.roleId === 'coordinator' || item.roleId === 'memory')).map(item => item.roleId)).size <= 1,
    'ROLE_CONFLICT', 'Saved coordinator and memory roles cannot share a session');
    const previous = new Map(requested.map(role => [role, db.get('bindings', role)]));
    // Recheck existence immediately before local registration; an unloaded carrier still occupies its role.
    for (const role of requested) {
      const binding = previous.get(role);
      if (binding && binding.sessionId !== sessionId) {
        requireFact(await this.meta(binding.sessionId) === null, 'ROLE_OCCUPIED', 'Existing role carrier still exists');
      }
    }
    requireFact(!this.stopped && !signal?.aborted, 'STOPPING',
      'Assistant stopped after native role save; registration is incomplete');
    db.transaction(() => {
      for (const role of requested) {
        const before = previous.get(role);
        const current = db.get('bindings', role);
        requireFact((current?.epoch ?? 0) === (before?.epoch ?? 0)
          && current?.sessionId === before?.sessionId, 'STALE_ROLE', 'Role changed before registration');
        if (current?.sessionId === sessionId) continue;
        requireFact(!db.find('bindings', item => item.id !== role && item.sessionId === sessionId).length,
          'ROLE_CONFLICT', 'One session cannot carry both internal roles');
        const binding: Binding = { id: role, sessionId, epoch: (before?.epoch ?? 0) + 1,
          definitionVersion: '2', modelId: meta.currentModelId ?? null, cwd: meta.cwd,
          ready: false, evidence: { registeredBy: requestId, saved: true, readiness: 'unchecked' } };
        db.put('bindings', binding);
        this.retireRoleWork(role, before);
      }
      db.put('operations', { id: key, fingerprint: fingerprint(input), state: 'accepted', result: input });
      this.service.changed();
    });
    for (const role of requested) this.retireBatch(previous.get(role));
    await this.observe(sessionId);
  }
  private retireBatch(previous: Binding | undefined): void {
    if (!previous) return;
    const current = this.service.db.get('bindings', previous.id);
    if (current?.sessionId === previous.sessionId && current.epoch === previous.epoch) return;
    const batch = this.service.activeBatch(previous.id);
    if (batch?.sessionId === previous.sessionId && batch.epoch === previous.epoch)
      this.service.finishBatch(batch.id, 'unknown');
  }
  private retireRoleWork(role: Role, previous: Binding | undefined): void {
    const { db } = this.service;
    for (const work of db.find('work', item => item.role === role && item.state === 'leased'
      && (role === 'memory' || !this.service.activeBatch()?.workIds.includes(item.id)))) {
      work.state = 'pending'; work.epoch = null; work.token = null; work.leaseUntil = 0;
      db.put('work', work);
    }
    if (!previous) return;
    for (const delivery of db.find('deliveries', item => item.kind === 'wake'
      && item.sessionId === previous.sessionId && item.roleEpoch === previous.epoch && item.state === 'pending')) {
      delivery.state = 'cancelled';
      db.put('deliveries', delivery);
    }
  }
  async readiness(): Promise<Readiness> {
    const roles = await Promise.all((['coordinator', 'memory'] as const).map(async role => {
      const binding = this.service.db.get('bindings', role);
      const result: RoleReadiness = { role, sessionId: binding?.sessionId ?? null,
        epoch: binding?.epoch ?? 0, modelId: binding?.modelId ?? null, cwd: binding?.cwd ?? null,
        status: binding ? 'unknown' : 'unbound', detail: null };
      if (!binding) return result;
      try {
        const verified = await this.verifyBinding(binding);
        result.modelId = verified.modelId;
        result.status = 'ready';
      } catch (error) {
        result.status = error instanceof BusinessError
          ? error.code === 'ROLE_UNLOADED' ? 'unloaded'
            : ['ROLE_CONFIGURATION', 'ROLE_NOT_READY', 'SESSION_MISSING'].includes(error.code) ? 'invalid' : 'unknown'
          : 'unknown';
        result.detail = errorText(error);
      }
      return result;
    }));
    const receptions = await Promise.all(this.service.db.activeReceptions().map(async reception => {
      let availability: Reception['availability'] = 'unknown';
      try {
        const meta = await this.meta(reception.id);
        availability = !meta ? 'missing' : meta.sessionId !== reception.id ? 'unknown'
          : meta.loaded === true ? 'loaded' : meta.loaded === false ? 'unloaded' : 'unknown';
      } catch {
        // A failed passive read is not evidence for the previously cached availability.
      }
      return { ...reception, availability };
    }));
    for (const result of roles) {
      const current = this.service.db.get('bindings', result.role);
      if (current?.sessionId !== (result.sessionId ?? undefined)
        || (current?.epoch ?? 0) !== result.epoch
        || current && (current.modelId !== result.modelId || current.cwd !== result.cwd)) {
        Object.assign(result, { sessionId: current?.sessionId ?? null, epoch: current?.epoch ?? 0,
          modelId: current?.modelId ?? null, cwd: current?.cwd ?? null,
          status: current ? 'unknown' : 'unbound', detail: 'Role changed during readiness check; refresh required.' });
      } else if (result.status === 'ready' && !current?.ready) {
        result.status = 'unknown';
        result.detail = 'A concurrent verification invalidated this role.';
      }
    }
    return { roles, canSend: roles.every(item => item.status === 'ready'), receptions };
  }
  async acceptReady(input: unknown): Promise<ReturnType<AssistantService['accept']>> {
    const value = inputSchema.parse(input);
    if (this.service.db.get('operations', `input:${value.requestId}`)) return this.service.accept(value);
    const readiness = await this.readiness();
    // Another identical request may have committed while verification was awaiting the host.
    if (this.service.db.get('operations', `input:${value.requestId}`)) return this.service.accept(value);
    requireFact(readiness.canSend && readiness.roles.every(role => {
      const current = this.service.db.get('bindings', role.role);
      return current?.ready && current.epoch === role.epoch && current.sessionId === role.sessionId
        && current.modelId === role.modelId && current.cwd === role.cwd;
    }), 'ROLES_NOT_READY', 'Both current role sessions must be freshly verified before accepting input', 409);
    return this.service.accept(value);
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
    if (meta && this.internal(meta)) {
      await this.observe(sessionId);
      return;
    }
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
      if (this.stopped || !await this.stillOrdinary(sessionId)) return;
      requireFact(typeof page.liveCursor === 'string', 'NO_LIVE_CURSOR', 'Native bootstrap returned no continuation cursor');
      db.transaction(() => {
        this.ingestion.applyWithinTransaction(sessionId, reception.generation, page.events, page.liveCursor!,
          true, false, this.liveEvents.get(sessionId));
        const current = db.must('receptions', sessionId);
        requireFact(current.generation === reception.generation, 'STALE_READER', 'Enrollment changed during bootstrap');
        current.baseline = true;
        current.cursor = page.liveCursor!;
        db.put('receptions', current);
      });
      this.liveEvents.delete(sessionId);
    }
    for (let count = 0; count < 16; count++) {
      const current = db.must('receptions', sessionId);
      const page = await this.native.read(sessionId, current.cursor, false);
      if (this.stopped || !await this.stillOrdinary(sessionId)) return;
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
      requireFact(!page.hasMore || page.cursor !== current.cursor, 'CURSOR_STALLED',
        'Native history cursor did not advance');
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
      const meta = await this.meta(sessionId);
      requireFact(meta?.loaded, 'SESSION_UNAVAILABLE', 'Load the original native session before recovery');
      requireFact(meta.sessionId === sessionId, 'SESSION_MISMATCH', 'Host returned a different session');
      requireFact(!this.internal(meta), 'INTERNAL_TARGET', 'Internal carrier history cannot be recovered as business input');
      while (pages < maxPages && hasMore) {
        const page = await this.native.read(sessionId, cursor, pages === 0, true);
        requireFact(!this.stopped, 'STOPPING', 'Runtime stopped during recovery');
        requireFact(await this.stillOrdinary(sessionId), 'INTERNAL_TARGET',
          'History target disappeared or became an internal carrier during recovery');
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
      db.transaction(() => {
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
      });
      this.sessions.add(sessionId);
      return db.must('operations', key);
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
    let expectedModel = binding.modelId;
    const matches = (current: Binding | undefined): boolean => !!current
      && current.epoch === binding.epoch && current.sessionId === binding.sessionId
      && current.modelId === binding.modelId && current.cwd === binding.cwd
      && current.definitionVersion === binding.definitionVersion;
    const checkMeta = (meta: PublicSessionMeta | null): void => {
      requireFact(meta, 'SESSION_MISSING', 'Bound role session no longer exists');
      requireFact(meta.sessionId === binding.sessionId, 'ROLE_CONFIGURATION', 'Host returned a different session');
      requireFact(meta.loaded === true, 'ROLE_UNLOADED', 'Bound role session is unloaded');
      expectedModel ??= meta.currentModelId ?? null;
      requireFact(expectedModel && meta.currentModelId === expectedModel && meta.cwd === binding.cwd,
        'ROLE_CONFIGURATION', 'Native role model or directory changed');
      requireFact(meta.rolesNeedReload !== true, 'ROLE_NOT_READY', 'Native role assembly requires reload');
    };
    try {
      requireFact(binding.definitionVersion === '2', 'ROLE_CONFIGURATION',
        'The role carrier must use the current Assistant definition');
      const meta = await this.meta(binding.sessionId);
      checkMeta(meta);
      const readiness = await this.native.host.call('roles/readiness', { sessionId: binding.sessionId,
        roles: [{ moduleId: 'assistant', roleId: binding.id }] });
      requireFact(readiness.sessionId === binding.sessionId && readiness.ready === true
        && readiness.loaded === true && readiness.rolesNeedReload === false
        && readiness.appliedRoles?.some(r => r.moduleId === 'assistant' && r.roleId === binding.id),
      'ROLE_NOT_READY', 'Role capability or applied role assembly is not confirmed');
      checkMeta(await this.meta(binding.sessionId));
      return this.service.db.transaction(() => {
        const current = this.service.db.must('bindings', binding.id);
        requireFact(matches(current), 'STALE_ROLE', 'Role changed during native readiness read');
        current.modelId = expectedModel;
        current.ready = true;
        current.evidence = { readiness, modelId: expectedModel, checkedAt: this.service.now() };
        this.service.db.put('bindings', current);
        return current;
      });
    } catch (error) {
      this.service.db.transaction(() => {
        const current = this.service.db.get('bindings', binding.id);
        if (current && matches(current)) {
          current.ready = false;
          current.evidence = { ...(error instanceof SessionMetadataPending ? { pending: true, code: error.code } : {}),
            error: errorText(error), checkedAt: this.service.now() };
          this.service.db.put('bindings', current);
        }
      });
      throw error;
    }
  }
  async authorize(identity: McpInvocationMeta, role: Role, epoch?: number): Promise<Binding> {
    requireFact(!this.stopped, 'STOPPING', 'Assistant is stopping', 503);
    const binding = this.service.authorize(identity, role, epoch);
    requireFact('toolCallId' in identity && typeof identity.toolCallId === 'string' && identity.toolCallId.length,
      'TOOL_ID_REQUIRED', 'Native MCP tool-call identity is required', 403);
    const toolCallId = identity.toolCallId;
    const batch = this.service.activeBatch(role);
    requireFact(batch && batch.sessionId === binding.sessionId && batch.epoch === binding.epoch,
      'NO_ACTIVE_BATCH', 'No current batch is assigned to this native role', 403);
    const id = `batch:${batch.id}`;
    let delivery = this.service.db.get('deliveries', id);
    if (delivery?.state === 'calling') {
      // A native hook may arrive before send() returns its receipt. Never infer its
      // batch from whichever wake happens to be calling; wait for the actual receipt.
      await new Promise<void>(resolve => {
        const waiters = this.receiptWaiters.get(id) ?? new Set<() => void>();
        const done = (): void => { clearTimeout(timer); waiters.delete(done); resolve(); };
        const timer = setTimeout(done, 5000);
        timer.unref();
        waiters.add(done);
        this.receiptWaiters.set(id, waiters);
      });
      delivery = this.service.db.get('deliveries', id);
    }
    requireFact(delivery?.state === 'accepted' && delivery.nativeMessageId,
      'RECEIPT_UNCONFIRMED', 'The native wake receipt is not confirmed; no decision was applied', 403);
    let calls: NativeChatEvent[] = [];
    let roots: NativeChatEvent[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.readConsumer(delivery);
      calls = this.service.db.consumerEvidence(binding.sessionId, 'toolCallId', toolCallId);
      roots = this.service.db.consumerEvidence(binding.sessionId, 'messageId', delivery.nativeMessageId);
      if (calls.length && roots.length) break;
      if (attempt < 2) await delay(attempt === 0 ? 10 : 25);
    }
    requireFact(calls.length === 1 && typeof calls[0]!.data.interactionId === 'string'
      && Array.isArray(calls[0]!.data.toolRequests)
      && calls[0]!.data.toolRequests.filter(request => request && typeof request === 'object'
        && 'toolCallId' in request && request.toolCallId === toolCallId).length === 1,
      'TOOL_PROVENANCE', 'Native tool identity has missing or ambiguous interaction evidence', 403);
    const interactionId = calls[0]!.data.interactionId;
    requireFact(roots.length === 1 && roots[0]!.data.interactionId === interactionId
      && this.service.db.consumerEvidence(binding.sessionId, 'interactionId', interactionId).length === 1,
      'TOOL_PROVENANCE', 'Native tool does not belong to this batch receipt', 403);
    const wakes = this.service.db.find('deliveries', item => item.kind === 'wake'
      && item.sessionId === binding.sessionId && item.nativeMessageId === delivery.nativeMessageId);
    requireFact(wakes.length === 1, 'RECEIPT_CONFLICT', 'Wake receipt is ambiguous', 403);
    const verified = await this.verifyBinding(binding);
    requireFact(!this.stopped, 'STOPPING', 'Assistant stopped during native authorization', 503);
    requireFact(this.service.activeBatch(role)?.id === batch.id
      && ['pending', 'running'].includes(this.service.db.must('batches', batch.id).state),
    'STALE_CONSUMER', 'The native tool belongs to a retired batch', 403);
    this.service.grantConsumer(identity, batch);
    return verified;
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
      requireFact(!db.get('receptions', value.sessionId)?.enabled, 'RECEPTION_TARGET', 'Active reception cannot become an internal role');
      requireFact(!db.find('bindings', b => b.id !== value.role && b.sessionId === value.sessionId).length,
        'ROLE_CONFLICT', 'One native session cannot carry both internal roles');
      db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'calling', result: null });
    });
    let result: unknown;
    const previous = db.get('bindings', value.role);
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
        requireFact(!db.get('receptions', value.sessionId)?.enabled
          && !db.find('bindings', b => b.id !== value.role && b.sessionId === value.sessionId).length,
        'ROLE_CONFLICT', 'Candidate was enrolled or assigned another role during preparation');
        const binding: Binding = { id: value.role, sessionId: value.sessionId, epoch: value.expectedEpoch + 1,
          definitionVersion: value.definitionVersion, modelId: value.expectedModelId, cwd: meta.cwd,
          ready: true, evidence: { preparation, readiness } };
        db.put('bindings', binding);
        this.retireRoleWork(value.role, previous);
        db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'accepted', result: binding });
        this.service.changed();
        return binding;
      });
    } catch (error) {
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value),
        state: 'unknown', result: { error: errorText(error), warning: 'Preparation may have applied; inspect native state before a new operation.' } }));
      throw error;
    }
    this.retireBatch(previous);
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
      requireFact(!this.stopped, 'STOPPING', 'Assistant stopped before session creation');
      db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'calling', result: null });
    });
    try {
      const result = await this.native.host.call('session/new', { cwd: value.cwd,
        ...(value.role ? { roles: [{ moduleId: 'assistant', roleId: value.role }] } : {}) });
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'accepted', result }));
      return result;
    } catch (error) {
      const detail = error !== null && typeof error === 'object' ? error : {};
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'unknown',
        result: { error: errorText(error),
          ...('code' in detail && typeof detail.code === 'string' ? { code: detail.code } : {}),
          ...('sessionId' in detail && typeof detail.sessionId === 'string' ? { sessionId: detail.sessionId } : {}),
          ...('createdId' in detail && typeof detail.createdId === 'string' ? { createdId: detail.createdId } : {}),
          ...('roleAssignment' in detail ? { roleAssignment: detail.roleAssignment } : {}) } }));
      throw error;
    }
  }
  private idle(meta: PublicSessionMeta | null): boolean {
    const activity = meta?.activity;
    return !!meta?.loaded && !meta.closing && meta.status === 'idle'
      && !meta.ask && !meta.decisions?.length && !!activity && !activity.processing
      && !activity.hasActiveWork && activity.queue.pendingCount === 0
      && activity.queue.steeringCount === 0 && activity.queue.inFlightSteeringCount === 0;
  }
  private async queueWorkers(): Promise<void> {
    const { db } = this.service;
    // Consume due wake-ups once, even when native readiness still prevents sending.
    // A busy carrier then waits for its next event instead of spinning on an expired timer.
    db.transaction(() => {
      for (const work of db.find('work', work => work.state === 'pending'
        && (work.retryAfter ?? 0) > 0 && work.retryAfter! <= this.service.now())) {
        work.retryAfter = 0;
        db.put('work', work);
      }
    });
    for (const binding of db.find('bindings', () => true)) {
      try {
        {
          const active = this.service.activeBatch(binding.id);
          if (active) {
            try { await this.consumeBatch(active); }
            catch (error) {
              if (error instanceof BusinessError && ['EVENT_ID_CONFLICT', 'SESSION_MISMATCH', 'CONSUMER_CURSOR'].includes(error.code))
                this.service.finishBatch(active.id, 'unknown');
              throw error;
            }
          }
          if (this.service.activeBatch(binding.id)) continue;
        }
        if (!binding.ready) continue;
        const pending = db.find('work', w => w.role === binding.id && (w.retryAfter ?? 0) <= this.service.now() && (w.state === 'pending'
          || binding.id === 'memory' && w.state === 'leased' && w.leaseUntil <= this.service.now()));
        if (!pending.length || !this.idle(await this.meta(binding.sessionId))) continue;
        await this.verifyBinding(binding);
        if (this.stopped) return;
        // Take a native boundary before the new consumer exists. Old busy/queued turns cannot
        // receive tools for a new batch, and an idle status alone never completes an old batch.
        const boundary = await this.native.read(binding.sessionId, null, true, false, true);
        requireFact(typeof boundary.liveCursor === 'string', 'NO_LIVE_CURSOR',
          'Consumer requires a native history boundary');
        if (this.stopped || !this.idle(await this.meta(binding.sessionId))) continue;
        requireFact('promptReceiptVersion' in this.native.host && this.native.host.promptReceiptVersion === 1,
          'HOST_CAPABILITY', 'Internal consumers require native prompt receipts and MCP tool-call identity');
        this.service.startBatch(binding, batch => {
          const id = `batch:${batch.id}`;
          db.setMeta(`consumer:${id}`, { cursor: boundary.liveCursor! } satisfies ConsumerRead);
          db.put('deliveries', { id, kind: 'wake', messageId: null, sessionId: binding.sessionId,
            batchId: batch.id, attachments: [],
            requestId: null, text: binding.id === 'coordinator' ? this.service.batchText(batch)
              : `Memory extraction work is available. Use assistant_memory_claim with role=memory, epoch=${binding.epoch}, `
                + 'then assistant_memory_read and assistant_remember with the returned source-bound proof. '
                + 'Drain pending extraction work. This is internal context, not new user authorization.',
            supplement: null, answerFreeform: null, state: 'pending', result: null, error: null,
            createdAt: this.service.now(), roleEpoch: binding.epoch });
        });
      } catch (error) { this.problem(`consumer:${binding.id}`, error); }
    }
  }
  private async consumeBatch(batch: Batch): Promise<void> {
    const { db } = this.service;
    const id = `batch:${batch.id}`;
    const delivery = db.get('deliveries', id);
    if (!delivery) {
      if (!this.service.recoverOrphanBatch(batch.id)) this.service.finishBatch(batch.id, 'unknown');
      return;
    }
    if (delivery.state === 'calling') return;
    if (delivery.state === 'pending') return;
    if (delivery.state === 'rejected' || delivery.state === 'cancelled') {
      this.service.finishBatch(batch.id, 'rejected', this.service.now() + 1000);
      return;
    }
    if (delivery.state === 'unknown') {
      this.service.finishBatch(batch.id, 'unknown');
      return;
    }
    if (batch.workIds.every(workId => ['done', 'invalidated', 'failed'].includes(db.must('work', workId).state))) {
      this.service.finishBatch(batch.id, 'finished');
      return;
    }
    await this.readConsumer(delivery);
  }
  private async readConsumer(delivery: Delivery): Promise<void> {
    const prior = this.consumerReads.get(delivery.id);
    if (prior) return prior;
    const pending = this.readConsumerPages(delivery).finally(() => this.consumerReads.delete(delivery.id));
    this.consumerReads.set(delivery.id, pending);
    return pending;
  }
  private async readConsumerPages(delivery: Delivery): Promise<void> {
    const { db } = this.service;
    const key = `consumer:${delivery.id}`;
    for (let count = 0; count < 16; count++) {
      const read = db.meta<ConsumerRead | null>(key, null);
      requireFact(read, 'CONSUMER_CURSOR', 'Native consumer history boundary is unavailable');
      const page = await this.native.read(delivery.sessionId, read.cursor, false, false, true);
      if (this.stopped) return;
      requireFact(page.cursorStatus !== 'expired' && typeof page.cursor === 'string'
        && (!page.hasMore || page.cursor !== read.cursor), 'CONSUMER_CURSOR', 'Native consumer cursor is unavailable');
      db.transaction(() => {
        for (const event of page.events) {
          if (event.ephemeral || !primary(event) || !['user.message', 'assistant.message'].includes(event.type)) continue;
          const string = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
          const fact: NativeChatEvent = { id: event.id, type: event.type, data: {
            messageId: string(event.data.messageId), interactionId: string(event.data.interactionId),
            ...(event.type === 'assistant.message' ? { toolRequests: Array.isArray(event.data.toolRequests)
              ? event.data.toolRequests.flatMap(request => request && typeof request === 'object'
                && 'toolCallId' in request && string(request.toolCallId)
                ? [{ toolCallId: request.toolCallId }] : []) : [] } : {}),
          } };
          const id = fingerprint([delivery.sessionId, event.id]);
          const old = db.get('native', id);
          requireFact(!old || fingerprint(old.event) === fingerprint(fact),
            'EVENT_ID_CONFLICT', 'Consumer event identity changed');
          if (!old) db.put('native', { id, sessionId: delivery.sessionId, event: fact, historical: false });
        }
        db.setMeta(key, { cursor: page.cursor });
      });
      if (page.hasMore) {
        if (count === 15) this.again = true;
        continue;
      }
      return;
    }
  }
  private async prepareDelivery(delivery: Delivery): Promise<PublicSessionMeta | null> {
    const { db } = this.service;
    if (this.stopped || (delivery.preparation?.nextAttemptAt ?? 0) > this.service.now()) return null;
    delivery.preparation = { attempts: (delivery.preparation?.attempts ?? 0) + 1,
      nextAttemptAt: 0, error: null };
    db.put('deliveries', delivery);
    if (delivery.kind !== 'wake') {
      const sources = delivery.messageIds ?? (delivery.messageId ? [delivery.messageId] : []);
      requireFact(!sources.some(id => {
        const source = db.get('messages', id);
        return source?.kind === 'user' && source.sessionId !== null;
      }), 'NATIVE_INPUT_ALREADY_SENT',
      'Ordinary Chat input was already sent to its session and cannot be dispatched again');
    }
    if (delivery.kind !== 'wake' && !delivery.sessionId) {
      await ensureTopicSession(this.service, this, delivery.id);
      Object.assign(delivery, db.must('deliveries', delivery.id));
    }
    if (delivery.kind !== 'wake' && !db.get('receptions', delivery.sessionId)) {
      await this.observe(delivery.sessionId);
    }
    let meta = await this.meta(delivery.sessionId);
    if (this.stopped) return null;
    requireFact(meta, 'SESSION_MISSING', 'The selected session no longer exists; it was not recreated');
    requireFact(meta.sessionId === delivery.sessionId, 'SESSION_MISMATCH', 'Host returned a different session');
    if (delivery.kind !== 'wake') {
      requireFact(!this.internal(meta), 'INTERNAL_TARGET', 'Target now has an internal role identity');
      this.service.reception(delivery.sessionId);
    }
    requireFact(!meta.closing, 'SESSION_TRANSITION', 'The selected session is closing');
    if (!meta.loaded && delivery.kind !== 'wake') {
      requireFact(delivery.preparation!.attempts <= 3, 'PREPARATION_EXHAUSTED', 'Bounded preparation attempts exhausted');
      const key = `delivery-load:${delivery.id}:${delivery.preparation!.attempts}`;
      const body = { sessionId: delivery.sessionId };
      db.transaction(() => {
        requireFact(db.must('deliveries', delivery.id).state === 'pending', 'EFFECT_CHANGED', 'Delivery changed during preparation');
        delivery.preparation!.loadOperationId = key;
        db.put('deliveries', delivery);
        db.put('operations', { id: key, fingerprint: fingerprint(body), state: 'calling', result: null });
      });
      try {
        const result = await this.native.host.call('session/load', body);
        requireFact(result.ok && result.sessionId === delivery.sessionId,
          'SESSION_MISMATCH', 'Load did not acknowledge the exact selected session');
        db.put('operations', { id: key, fingerprint: fingerprint(body), state: 'accepted', result });
      } catch (error) {
        db.put('operations', { id: key, fingerprint: fingerprint(body), state: 'unknown',
          result: { error: errorText(error), next: 'Read the exact session state before another existing-only load; no message call was made.' } });
        throw error;
      }
      if (this.stopped) return null;
      meta = await this.meta(delivery.sessionId);
      if (this.stopped) return null;
      requireFact(meta, 'SESSION_MISSING', 'The selected session disappeared during loading');
      requireFact(meta.sessionId === delivery.sessionId, 'SESSION_MISMATCH', 'Host returned a different session after loading');
      requireFact(!this.internal(meta), 'INTERNAL_TARGET', 'Target became an internal role carrier while loading');
      this.service.reception(delivery.sessionId);
    }
    requireFact(meta.loaded && !meta.closing, 'SESSION_TRANSITION', 'The selected session is not yet loaded and available');
    if (delivery.kind !== 'wake') {
      const reception = this.service.reception(delivery.sessionId);
      if (!reception.baseline && !reception.gap) {
        await this.consume(delivery.sessionId);
        if (this.stopped) return null;
        meta = await this.meta(delivery.sessionId);
        if (this.stopped) return null;
        requireFact(meta?.sessionId === delivery.sessionId, 'SESSION_MISSING', 'Target disappeared while preparing observation');
        requireFact(!this.internal(meta), 'INTERNAL_TARGET', 'Target changed role while preparing observation');
        requireFact(meta.loaded && !meta.closing, 'SESSION_TRANSITION', 'Target changed availability while preparing observation');
      }
      db.put('receptions', { ...this.service.reception(delivery.sessionId), availability: 'loaded' });
    }
    return meta;
  }
  private async send(id: string): Promise<void> {
    const db = this.service.db;
    let delivery = db.must('deliveries', id);
    if (delivery.state !== 'pending') return;
    const validateAnswer = (meta: PublicSessionMeta): void => {
      const asks = meta.decisions?.filter(d => d.kind === 'ask').map(d => d.request) ?? (meta.ask ? [meta.ask] : []);
      if (delivery.kind === 'wake') {
        requireFact(delivery.attachments.length === 0, 'INTERNAL_ATTACHMENTS',
          'Internal wakes must not carry user attachments');
      } else if (delivery.kind === 'ask') {
        const ask = asks.find(q => q.requestId === delivery.requestId);
        const stored = db.must('questions', questionKey(delivery.sessionId, delivery.requestId!));
        requireFact(asks.filter(q => q.requestId === delivery.requestId).length === 1
          && ask && stored.state === 'pending' && fingerprint(ask) === fingerprint(stored.request),
          'STALE_ASK', 'The exact original native question is no longer pending');
        requireFact(askAnswer(ask, delivery.text, delivery.attachments) === delivery.answerFreeform,
          'ANSWER_CHANGED', 'Frozen answer mode does not match the original native question');
      } else {
        requireFact(asks.length === 0 && !db.find('questions', q => q.sessionId === delivery.sessionId
          && q.state === 'pending').length, 'PENDING_ASK',
        'A native question is pending; do not bypass it with an ordinary prompt');
      }
    };
    try {
      const meta = await this.prepareDelivery(delivery);
      if (!meta) return;
      if (delivery.kind === 'wake') {
        const binding = db.find('bindings', b => b.sessionId === delivery.sessionId && b.epoch === delivery.roleEpoch)[0];
        requireFact(binding, 'STALE_ROLE', 'Wake belongs to a retired role epoch');
        await this.verifyBinding(binding);
        if (!this.idle(await this.meta(delivery.sessionId))) return;
      } else {
        requireFact(!this.internal(meta), 'INTERNAL_TARGET', 'Target now has an internal role identity');
        this.service.reception(delivery.sessionId);
        if (delivery.kind === 'prompt') db.transaction(() => this.service.syncQuestions(delivery.sessionId,
          meta.decisions?.filter(item => item.kind === 'ask').map(item => item.request) ?? (meta.ask ? [meta.ask] : []), true));
      }
      validateAnswer(meta);
      if (this.stopped) return;
      db.transaction(() => {
        delivery = db.must('deliveries', id);
        requireFact(delivery.state === 'pending', 'EFFECT_CHANGED', 'Effect changed before native call');
        if (delivery.kind === 'wake') {
          requireFact(db.find('bindings', b => b.sessionId === delivery.sessionId && b.epoch === delivery.roleEpoch && b.ready).length === 1,
            'STALE_ROLE', 'Role was replaced immediately before wake dispatch');
        } else this.service.reception(delivery.sessionId);
        validateAnswer(meta);
        delivery.state = 'calling';
        db.put('deliveries', delivery);
      });
    } catch (error) {
      if (this.stopped) return;
      db.transaction(() => {
        delivery = db.must('deliveries', id);
        if (delivery.state !== 'pending') return;
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
        const permanent = ['SESSION_MISSING', 'SESSION_MISMATCH', 'INTERNAL_TARGET', 'NOT_FOUND',
          'RECEPTION_DISABLED', 'NOT_RECEPTION', 'FORBIDDEN', 'UNAUTHORIZED', 'EACCES', 'EPERM',
          'STALE_ROLE', 'ROLE_CONFIGURATION', 'STALE_ASK', 'PENDING_ASK',
          'ANSWER_CHANGED', 'FREEFORM_FORBIDDEN', 'INTERNAL_ATTACHMENTS',
          'ASK_ATTACHMENTS_UNSUPPORTED', 'AMBIGUOUS_CHOICE',
          'ATTACHMENTS_NOT_SUPPORTED', 'PREPARATION_EXHAUSTED', 'TOPIC_CREATE_UNKNOWN', 'NATIVE_INPUT_ALREADY_SENT'];
        // Only preparation is retried. A calling/unknown message is never returned here.
        if (!permanent.includes(String(code))
          && delivery.preparation && delivery.preparation.attempts < 3) {
          delivery.preparation.nextAttemptAt = this.service.now() + 1000 * delivery.preparation.attempts;
          delivery.preparation.error = errorText(error);
          db.put('deliveries', delivery);
          return;
        }
        delivery.state = code === 'TOPIC_CREATE_UNKNOWN' ? 'unknown' : 'rejected';
        delivery.error = errorText(error);
        db.put('deliveries', delivery);
        if (delivery.kind === 'ask' && error instanceof BusinessError && error.code === 'STALE_ASK') {
          const question = db.must('questions', questionKey(delivery.sessionId, delivery.requestId!));
          if (question.state === 'pending') this.service.questionState(question, 'stale');
        }
        this.service.publish({ type: 'status', messageId: delivery.messageId,
          topicId: delivery.topicId ?? null, text: delivery.error });
      });
      const failed = db.must('deliveries', id);
      if (failed.batchId && ['rejected', 'unknown'].includes(failed.state))
        this.service.finishBatch(failed.batchId, failed.state === 'rejected' ? 'rejected' : 'unknown', this.service.now() + 1000);
      return;
    }
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
          text: delivery.supplement ? `${delivery.text}\n\n---\n${delivery.supplement}` : delivery.text,
          ...(delivery.attachments.length ? { attachments: delivery.attachments } : {}) });
        state = typeof result === 'object' && result !== null && 'ok' in result
          ? result.ok === true ? 'accepted' : result.ok === false ? 'rejected' : 'unknown' : 'unknown';
      }
    } catch (failure) {
      state = 'unknown'; result = null; error = errorText(failure);
    }
    db.transaction(() => {
      // Re-read after the asynchronous native call; other durable observations may have advanced.
      delivery = db.must('deliveries', id);
      delivery.state = state; delivery.result = result; delivery.error = error;
      if (delivery.kind !== 'ask' && state === 'accepted') {
        const receipt = result !== null && typeof result === 'object' && 'messageId' in result
          && typeof result.messageId === 'string' && result.messageId.length > 0 ? result.messageId : null;
        if (receipt) {
          delivery.nativeMessageId = receipt;
          delivery.interactionState = 'pending';
        } else if (delivery.kind === 'wake') {
          state = 'unknown';
          delivery.state = state;
          delivery.error = 'Native acceptance omitted its message receipt; the effect was not repeated.';
        }
      }
      db.put('deliveries', delivery);
      if (delivery.kind === 'ask') {
        const question = db.must('questions', questionKey(delivery.sessionId, delivery.requestId!));
        if (state === 'accepted') this.service.questionState(question, 'answered');
        if (state === 'unknown') this.service.questionState(question, 'unknown');
      }
      if (state === 'rejected') delivery.error = `Native ${delivery.kind} explicitly rejected the original input`;
      db.put('deliveries', delivery);
      if (delivery.kind === 'wake' && state === 'accepted' && delivery.batchId) {
        const batch = db.must('batches', delivery.batchId);
        if (batch.state === 'pending') { batch.state = 'running'; db.put('batches', batch); }
      }
      if (state !== 'accepted') this.service.publish({ type: 'status', messageId: delivery.messageId,
        topicId: delivery.topicId ?? null,
        text: state === 'unknown' ? 'Delivery could not be confirmed and was not repeated.'
          : 'Delivery was not accepted. Please clarify or try a new request.' });
    });
    for (const done of this.receiptWaiters.get(id) ?? []) done();
    this.receiptWaiters.delete(id);
    if (delivery.batchId && state !== 'accepted')
      this.service.finishBatch(delivery.batchId, state === 'rejected' ? 'rejected' : 'unknown', this.service.now() + 1000);
    if (delivery.kind === 'ask' || state === 'accepted' && delivery.kind === 'prompt') {
      this.sessions.add(delivery.sessionId);
      this.again = true;
    }
  }
}

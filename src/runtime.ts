import type { McpInvocationMeta, ModuleHostApi, NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { BusinessError, errorText, requireFact } from './errors.ts';
import { Ingestion } from './ingestion.ts';
import { AssistantService, questionKey } from './service.ts';
import type { Binding, Delivery, Operation, Reception, Role } from './types.ts';
import { activateRolesSchema, bindingSchema, createSessionSchema, enrollSchema, inputSchema } from './schema.ts';
import type { Readiness, RoleReadiness, SessionInspection } from './ui-types.ts';

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
  coordinator: ['assistant_read', 'assistant_claim', 'assistant_decide', 'assistant_create_session'],
  memory: ['assistant_read', 'assistant_claim', 'assistant_remember'],
};

export class Runtime {
  readonly ingestion: Ingestion;
  private sessions = new Set<string>();
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private liveEnds = new Map<string, Set<string>>();
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
        await this.observe(session.sessionId);
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
  private internal(meta: PublicSessionMeta): boolean {
    return [...(meta.roles ?? []), ...(meta.appliedRoles ?? [])].some(item =>
      item.moduleId === 'assistant' && (item.roleId === 'coordinator' || item.roleId === 'memory'))
      || this.service.db.find('bindings', binding => binding.sessionId === meta.sessionId).length > 0;
  }
  noteEvent(sessionId: string, event: NativeChatEvent): void {
    if (event.type !== 'assistant.turn_end' || this.service.db.get('receptions', sessionId)?.baseline) return;
    const ends = this.liveEnds.get(sessionId) ?? new Set<string>();
    ends.add(event.id);
    this.liveEnds.set(sessionId, ends);
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
    if (this.stopped) return;
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
          }
          if (excluded) for (const work of db.find('work', item => item.state !== 'done'
            && !!item.messageId && db.get('messages', item.messageId)?.sessionId === sessionId)) {
            work.state = 'invalidated';
            db.put('work', work);
          }
          this.service.changed();
        }
        this.liveEnds.delete(sessionId);
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
          definitionVersion: '1', modelId: meta.currentModelId ?? null, cwd: meta.cwd,
          ready: false, evidence: { registeredBy: requestId, saved: true, readiness: 'unchecked' } };
        db.put('bindings', binding);
        this.retireRoleWork(role, before);
      }
      db.put('operations', { id: key, fingerprint: fingerprint(input), state: 'accepted', result: input });
      this.service.changed();
    });
    await this.observe(sessionId);
  }
  private retireRoleWork(role: Role, previous: Binding | undefined): void {
    const { db } = this.service;
    for (const work of db.find('work', item => item.role === role && item.state === 'leased')) {
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
          true, false, this.liveEnds.get(sessionId));
        const current = db.must('receptions', sessionId);
        requireFact(current.generation === reception.generation, 'STALE_READER', 'Enrollment changed during bootstrap');
        current.baseline = true;
        current.cursor = page.liveCursor!;
        db.put('receptions', current);
      });
      this.liveEnds.delete(sessionId);
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
          current.evidence = { error: errorText(error), checkedAt: this.service.now() };
          this.service.db.put('bindings', current);
        }
      });
      throw error;
    }
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
      requireFact(!db.get('receptions', value.sessionId)?.enabled, 'RECEPTION_TARGET', 'Active reception cannot become an internal role');
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
        requireFact(!db.get('receptions', value.sessionId)?.enabled
          && !db.find('bindings', b => b.id !== value.role && b.sessionId === value.sessionId).length,
        'ROLE_CONFLICT', 'Candidate was enrolled or assigned another role during preparation');
        const previous = db.get('bindings', value.role);
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
      requireFact(db.find('operations', op => op.id.startsWith('create:')
        && (op.state === 'unknown' || op.state === 'calling')).length === 0,
        'UNRESOLVED_CREATE', 'Resolve uncertain native creation before creating another session');
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
          ...('roleAssignment' in detail ? { roleAssignment: detail.roleAssignment } : {}) } }));
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
        requireFact(!this.internal(meta), 'INTERNAL_TARGET', 'Target now has an internal role identity');
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

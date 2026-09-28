import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpInvocationMeta, ModuleRequest, ModuleResponse, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { BusinessError, requireFact } from './errors.ts';
import type { Runtime } from './runtime.ts';
import type { AssistantService } from './service.ts';
import { ref } from './service.ts';
import { publicationStream } from './stream.ts';
import { createTopicSession } from './topic-session.ts';
import { inputReceipt, timeline, timelineItem } from './ui.ts';
import { activateRolesSchema, bindingSchema, claimSchema, configSchema, createSessionSchema, createTopicSessionSchema, decisionSchema, enrollSchema,
  id, inputSchema, rememberSchema, role, roleReadSchema, text } from './schema.ts';
import type { Delivery, Message, Table } from './types.ts';

const evidence = z.string().trim().min(1).max(4000);
const integerQuery = z.union([z.int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.int().nonnegative());
const pageSchema = z.strictObject({
  after: integerQuery.default(0), limit: integerQuery.pipe(z.number().min(1).max(100)).default(50),
});
const pathSchema = z.strictObject({ id });
const operationPathSchema = z.strictObject({ id: z.string().min(1).max(512) });
const messageVersionPathSchema = pathSchema.extend({ version: integerQuery.pipe(z.number().positive()) });
const assignmentPathSchema = pathSchema.extend({ version: integerQuery });
const streamQuerySchema = z.strictObject({ after: integerQuery.optional() });
const timelineQuerySchema = z.strictObject({
  before: integerQuery.optional(), after: integerQuery.optional(),
  limit: integerQuery.pipe(z.number().min(1).max(100)).optional(),
}).refine(value => value.before === undefined || value.after === undefined, 'before and after are mutually exclusive');
const requestSchema = z.strictObject({ requestId: id });
const focusSchema = requestSchema.extend({ topicId: id });
const handoffSchema = focusSchema.extend({ evidence });
const topicPatchSchema = requestSchema.extend({
  expectedVersion: z.int().positive(), title: z.string().trim().min(1).max(240).optional(),
  domain: z.string().max(240).nullable().optional(), pinned: z.boolean().optional(),
  archived: z.boolean().optional(), independent: z.boolean().optional(),
}).refine(value => ['title', 'domain', 'pinned', 'archived', 'independent'].some(key => key in value),
  'At least one topic field is required');
const receptionPatchSchema = requestSchema.extend({
  expectedVersion: z.int().positive(), evidence, enabled: z.boolean().optional(),
  kind: z.enum(['reception', 'collaborator']).optional(), label: z.string().trim().min(1).max(240).optional(),
}).refine(value => ['enabled', 'kind', 'label'].some(key => key in value), 'At least one reception field is required');
const recoverSchema = requestSchema.extend({
  maxPages: z.int().min(1).max(10), acknowledgeGap: z.literal(true), evidence,
});
const suppressSchema = requestSchema.extend({
  sessionId: id, signature: id, confirmed: z.literal(true), evidence,
});
const resolveSchema = requestSchema.extend({
  target: z.enum(['delivery', 'operation']), state: z.enum(['accepted', 'rejected', 'cancelled']), evidence,
});
const operationResolveSchema = resolveSchema.omit({ target: true });
const retrySchema = requestSchema.extend({ evidence });
const correctionSchema = requestSchema.extend({ expectedVersion: z.int().positive(), text, reason: evidence });
const classifySchema = requestSchema.extend({
  expectedVersion: z.int().positive(), expectedAssignmentVersion: z.int().nonnegative(),
  topic: decisionSchema.shape.topic, reason: evidence,
});
const verifySchema = requestSchema.extend({ role, expectedEpoch: z.int().positive() });
const refreshSchema = verifySchema.omit({ role: true });
const configPatchSchema = requestSchema.extend({ config: z.strictObject({
  riskEnabled: configSchema.shape.riskEnabled.removeDefault().optional(),
  riskCooldownMs: configSchema.shape.riskCooldownMs.removeDefault().optional(),
  maxReceptions: configSchema.shape.maxReceptions.removeDefault().optional(),
}) });
const identitySchema = z.object({
  sessionId: id, runtimeSessionId: id, subagent: z.boolean(), agentName: id.optional(),
});
const metaSchema = z.record(z.string(), z.unknown());
const rpcSchema = z.strictObject({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1), params: z.unknown().optional(),
});
const initializeSchema = z.strictObject({
  protocolVersion: z.string().min(1), capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
  _meta: metaSchema.optional(),
});
const callSchema = z.strictObject({ name: z.string(), arguments: z.unknown().optional(), _meta: metaSchema.optional() });
const emptyParams = z.strictObject({ _meta: metaSchema.optional() });
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const dialect = 'https://json-schema.org/draft/2020-12/schema';
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const toolDefinitions = [
  { name: 'assistant_read', schema: roleReadSchema,
    description: 'Read bounded Assistant-owned durable state, never the host session catalog or arbitrary native history. '
      + 'Use your current bound role and epoch. Claim work first. Memory reads require a current leased workId and are restricted to its topic and versioned sources.' },
  { name: 'assistant_claim', schema: claimSchema,
    description: 'Claim one durable work item for the current ready main role and epoch. Save its token, inputVersion and stateVersion. '
      + 'Read the input and relevant Assistant state, then submit one structured decision or memory result. Null means no work; do not invent work.' },
  { name: 'assistant_decide', schema: decisionSchema,
    description: 'Coordinator only: submit a structured classification and route, publish, clarify, or suppress decision for claimed work. '
      + 'Use the exact lease proof, a stable requestId, and current routeVersion. Explicit reply anchors cannot be redirected; native effects are queued durably, never blindly retried.' },
  { name: 'assistant_remember', schema: rememberSchema,
    description: 'Memory role only: commit sourced confirmed, reported, or inferred entries for your claimed memory work. '
      + 'Use a stable requestId and exact lease proof; every source must match the claimed version and assignment. Never infer user confirmation from a report.' },
  { name: 'assistant_create_session', schema: createTopicSessionSchema,
    description: 'Coordinator only: reserve one ordinary session creation for current leased unanchored user input when no suitable existing reception exists. '
      + 'Provide an explicit absolute cwd supported by user/task context and explain that evidence in reason; clarify if unknown. '
      + 'Uses the native default model, no internal roles, no automatic routing. Keep the exact request for replay; read receipts on uncertainty. '
      + 'After creation, claim and read fresh state before assistant_decide. Never replace an uncertain creation with a new request.' },
];

function knownError(error: unknown): { code: string; message: string; status: number; issues?: unknown } | null {
  if (error instanceof BusinessError) return { code: error.code, message: error.message, status: error.status };
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: 'Request validation failed', status: 400, issues: error.issues };
  return null;
}

/** Routes are relative to the authenticated module API base; this service is the sole private space. */
export function routes(service: AssistantService, runtime: Runtime): ModuleRoute[] {
  const { db } = service;
  const wake = (sessionId?: string): void => {
    // Never await a pump from a tool call: its own native prompt may be awaiting this response.
    void Promise.resolve().then(() => runtime.wake(sessionId)).catch(error => runtime.report(error));
  };
  const mutate = <T>(name: string, requestId: string, value: unknown, action: () => T): T =>
    db.transaction(() => service.idempotent(`http:${name}:${requestId}`, value, action));
  const api = (method: ModuleRoute['method'], path: string,
    action: (request: ModuleRequest) => unknown | Promise<unknown>): ModuleRoute => ({
    method, path, ...(method === 'GET' ? {} : { body: 'json' as const, bodyLimit: 2_000_000 }),
    async handler(request): Promise<ModuleResponse> {
      try {
        if (method !== 'GET') z.strictObject({}).parse(request.query);
        const body = await action(request);
        if (method !== 'GET' && path !== '/wake') wake();
        return { headers: jsonHeaders, body };
      } catch (error) {
        const known = knownError(error);
        if (!known) throw error;
        return { status: known.status, headers: jsonHeaders, body: { error: known } };
      }
    },
  });
  // Operations wrapping helpers with their own transaction reserve intent first. An interrupted
  // call remains visible, and replay never invokes it again without explicit resolution.
  const recorded = async <T>(name: string, requestId: string, value: unknown, action: () => T | Promise<T>): Promise<unknown> => {
    const key = `http:${name}:${requestId}`;
    const prior = db.get('operations', key);
    if (prior) {
      requireFact(prior.fingerprint === fingerprint(value), 'IDEMPOTENCY_CONFLICT', 'Request ID already has different input');
      return prior;
    }
    db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'calling', result: null }));
    try {
      const result = await action();
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value), state: 'accepted', result }));
      return db.must('operations', key);
    } catch (error) {
      const known = knownError(error);
      db.transaction(() => db.put('operations', { id: key, fingerprint: fingerprint(value),
        state: known ? 'rejected' : 'unknown', result: known ? { error: known } : { error: 'Operation outcome is uncertain; inspect before resolving.' } }));
      throw error;
    }
  };
  const resolve = (effectId: string, value: z.infer<typeof resolveSchema>): unknown =>
    mutate('resolve', value.requestId, { effectId, ...value }, () => {
      const table = value.target === 'delivery' ? 'deliveries' : 'operations';
      const effect = db.must(table, effectId);
      requireFact(effect.state === 'unknown', 'EFFECT_NOT_UNKNOWN', 'Only uncertain effects can be explicitly resolved');
      effect.state = value.state;
      effect.result = { previous: effect.result, resolution: { state: value.state, evidence: value.evidence,
        requestId: value.requestId, at: service.now() } };
      db.put(table, effect);
      service.publish({ type: 'status', text: `${value.target} ${effectId}: explicitly resolved ${value.state}. Evidence: ${value.evidence}` });
      service.changed();
      return effect;
    });
  const verify = (value: z.infer<typeof verifySchema>): Promise<unknown> =>
    recorded('verify', value.requestId, value, () => {
      const binding = db.must('bindings', value.role);
      requireFact(binding.epoch === value.expectedEpoch, 'STALE_ROLE', 'Role epoch changed');
      return runtime.verifyBinding(binding);
    });
  const roleRead = (identity: McpInvocationMeta, value: z.infer<typeof roleReadSchema>): unknown =>
    db.transaction(() => {
      service.authorize(identity, value.role, value.epoch);
      const { resource, after, limit } = value;
      if (resource === 'receipts') {
        requireFact(value.workId, 'WORK_REQUIRED', 'Receipt reads require the exact workId', 400);
        const work = db.must('work', value.workId);
        requireFact(work.role === value.role, 'SOURCE_SCOPE', 'Receipt belongs to a different role', 403);
        return { workId: work.id, state: work.state, epoch: work.epoch, inputVersion: work.inputVersion,
          ...(value.role === 'coordinator' ? { sessionCreation: db.get('operations', `topic-create:${work.id}`) ?? null } : {}),
          result: work.state === 'done' ? work.result : null };
      }
      if (value.role === 'coordinator') {
        if (resource === 'work') {
          const readable = (work: ReturnType<AssistantService['claim']>): boolean =>
            !!work && work.role === value.role && work.state === 'leased'
              && work.epoch === value.epoch && work.leaseUntil > service.now();
          if (value.workId) requireFact(readable(db.must('work', value.workId)),
            'STALE_LEASE', 'Work is not currently leased to this role', 403);
          const page = db.list('work', after, limit);
          return { ...page, items: page.items.filter(work => readable(work) && (!value.workId || work.id === value.workId)) };
        }
        return db.list(resource, after, limit);
      }
      requireFact(value.workId, 'WORK_REQUIRED', 'Memory reads require a claimed workId', 403);
      const work = db.must('work', value.workId);
      requireFact(work.role === 'memory' && work.epoch === value.epoch && work.state === 'leased'
        && work.leaseUntil > service.now(), 'STALE_LEASE', 'Memory work is not currently leased to this role', 403);
      const sources = new Map(work.sources.map(source => [source.messageId, source]));
      for (const source of sources.values()) {
        const message = db.must('messages', source.messageId);
        requireFact(message.version === source.version && message.assignmentVersion === source.assignmentVersion
          && message.topicId === work.topicId, 'STALE_SOURCE', 'Claimed memory source changed', 409);
      }
      switch (resource) {
        case 'work': {
          const page = db.list('work', after, limit);
          return { ...page, items: page.items.filter(item => item.id === work.id) };
        }
        case 'topics': {
          const page = db.list('topics', after, limit);
          return { ...page, items: page.items.filter(item => item.id === work.topicId) };
        }
        case 'messages': {
          const page = db.list('messages', after, limit);
          return { ...page, items: page.items.filter(item => sources.has(item.id)) };
        }
        case 'memories': {
          const page = db.list('memories', after, limit);
          return { ...page, items: page.items.filter(item => item.topicId === work.topicId && item.valid
            && item.sources.every(source => {
              const allowed = sources.get(source.messageId);
              return allowed?.version === source.version && allowed.assignmentVersion === source.assignmentVersion;
            })) };
        }
        default: throw new BusinessError('SOURCE_SCOPE', 'Memory role cannot read this resource', 403);
      }
    });
  const status = (request: ModuleRequest): unknown => {
    z.strictObject({}).parse(request.query);
    return { stateVersion: service.version, foregroundTopic: db.meta('foregroundTopic', null), config: service.config,
      roles: db.list('bindings', 0, 2).items, publicationCursor: db.meta('publicationSequence', 0) };
  };
  const result: ModuleRoute[] = [
    api('GET', '/state', status), api('GET', '/status', status),
    api('GET', '/timeline', request => {
      const { before, after, limit } = timelineQuerySchema.parse(request.query);
      return timeline(service, before, after, limit ?? (after === undefined ? 50 : 100));
    }),
    api('GET', '/timeline/items/:sequence', request => {
      z.strictObject({}).parse(request.query);
      const { sequence } = z.strictObject({ sequence: integerQuery.pipe(z.number().positive()) }).parse(request.params);
      const publication = db.publication(sequence);
      requireFact(publication, 'NOT_FOUND', 'Publication not found', 404);
      return timelineItem(service, publication);
    }),
    api('GET', '/readiness', request => {
      z.strictObject({}).parse(request.query);
      return runtime.readiness();
    }),
    api('GET', '/sessions/:id/inspect', request => {
      z.strictObject({}).parse(request.query);
      return runtime.inspect(pathSchema.parse(request.params).id);
    }),
    api('GET', '/operations/:id', request => {
      z.strictObject({}).parse(request.query);
      return db.must('operations', operationPathSchema.parse(request.params).id);
    }),
    api('GET', '/inputs/:requestId', request => {
      z.strictObject({}).parse(request.query);
      return inputReceipt(service, requestSchema.parse(request.params).requestId);
    }),
  ];
  result.push({
    method: 'GET', path: '/timeline/stream',
    handler(request): ModuleResponse {
      try {
        const query = streamQuerySchema.parse(request.query);
        const lastEventId = integerQuery.optional().parse(request.headers['last-event-id']);
        return publicationStream(service, lastEventId ?? query.after ?? 0, request.signal,
          publication => timelineItem(service, publication));
      } catch (error) {
        const known = knownError(error);
        if (!known) throw error;
        return { status: known.status, headers: jsonHeaders, body: { error: known } };
      }
    },
  });
  for (const [path, table] of Object.entries({
    topics: 'topics', history: 'publications', publications: 'publications', messages: 'messages',
    events: 'publications', receptions: 'receptions', questions: 'questions', deliveries: 'deliveries',
    operations: 'operations', memories: 'memories', roles: 'bindings', risks: 'risks', routes: 'routes',
  }) as [string, Table][]) result.push(api('GET', `/${path}`, request => {
    const page = pageSchema.parse(request.query);
    return db.list(table, page.after, page.limit);
  }));
  result.push(
    {
      method: 'GET', path: '/events/stream',
      handler(request): ModuleResponse {
        try {
          const query = streamQuerySchema.parse(request.query);
          const lastEventId = integerQuery.optional().parse(request.headers['last-event-id']);
          // A reconnect header advances past the EventSource URL's original cursor.
          return publicationStream(service, lastEventId ?? query.after ?? 0, request.signal);
        } catch (error) {
          const known = knownError(error);
          if (!known) throw error;
          return { status: known.status, headers: jsonHeaders, body: { error: known } };
        }
      },
    },
    api('GET', '/messages/:id/versions/:version', request => {
      z.strictObject({}).parse(request.query);
      const { id: messageId, version } = messageVersionPathSchema.parse(request.params);
      const current = db.must('messages', messageId);
      requireFact(version <= current.version, 'NOT_FOUND', 'Message version not found', 404);
      const message = version === current.version ? current : db.meta<Message | null>(`revision:${messageId}:${version}`, null);
      requireFact(message, 'NOT_FOUND', 'Message version not found', 404);
      const correction = db.meta<{ reason: string; origin: string; at: number } | null>(`correction:${messageId}:${version}`, null);
      return { message, correction };
    }),
    api('GET', '/messages/:id/assignments/:version', request => {
      z.strictObject({}).parse(request.query);
      const { id: messageId, version } = assignmentPathSchema.parse(request.params);
      const current = db.must('messages', messageId);
      requireFact(version <= current.assignmentVersion, 'NOT_FOUND', 'Message assignment not found', 404);
      const assignment = version === current.assignmentVersion
        ? { topicId: current.topicId, reason: current.assignmentReason }
        : db.meta<{ topicId: string | null; reason: string | null } | null>(`assignment:${messageId}:${version}`, null);
      requireFact(assignment, 'NOT_FOUND', 'Message assignment not found', 404);
      return { messageId, assignmentVersion: version, ...assignment };
    }),
    api('GET', '/roles/:role', request => {
      z.strictObject({}).parse(request.query);
      return db.must('bindings', z.strictObject({ role }).parse(request.params).role);
    }),
    api('POST', '/messages', request => runtime.acceptReady(inputSchema.parse(request.body))),
    api('POST', '/enrollment', request => runtime.enroll(enrollSchema.parse(request.body))),
    api('POST', '/sessions', request => runtime.create(createSessionSchema.parse(request.body))),
    api('POST', '/roles/bind', request => runtime.bind(bindingSchema.parse(request.body))),
    api('POST', '/roles/activate', request => runtime.activateRoles(activateRolesSchema.parse(request.body))),
    api('POST', '/roles/verify', request => verify(verifySchema.parse(request.body))),
    api('POST', '/roles/:role/refresh', request => verify({
      ...refreshSchema.parse(request.body), role: z.strictObject({ role }).parse(request.params).role,
    })),
    api('POST', '/focus', request => {
      const value = focusSchema.parse(request.body);
      return mutate('focus', value.requestId, value, () => {
        service.switchTopic(value.topicId);
        return { topicId: value.topicId, stateVersion: service.version };
      });
    }),
    api('POST', '/handoff', request => {
      const value = handoffSchema.parse(request.body);
      return mutate('handoff', value.requestId, value, () => {
        db.must('topics', value.topicId);
        const work = service.memory.schedule(value.topicId, 'handoff');
        service.changed();
        return { work: work ?? null, evidence: value.evidence };
      });
    }),
    api('PATCH', '/config', request => {
      const value = configPatchSchema.parse(request.body);
      return mutate('config', value.requestId, value, () => {
        const config = configSchema.parse({ ...service.config, ...value.config });
        db.setMeta('config', config);
        service.changed();
        return config;
      });
    }),
    api('PATCH', '/topics/:id', request => {
      const topicId = pathSchema.parse(request.params).id;
      const value = topicPatchSchema.parse(request.body);
      return mutate('topic', value.requestId, { topicId, ...value }, () => {
        const topic = db.must('topics', topicId);
        requireFact(topic.version === value.expectedVersion, 'STALE_TOPIC', 'Topic version changed');
        const { requestId: _requestId, expectedVersion: _expectedVersion, ...changes } = value;
        Object.assign(topic, changes);
        topic.version++;
        db.put('topics', topic);
        service.changed();
        return topic;
      });
    }),
    api('PATCH', '/receptions/:id', request => {
      const sessionId = pathSchema.parse(request.params).id;
      const value = receptionPatchSchema.parse(request.body);
      return mutate('reception', value.requestId, { sessionId, ...value }, () => {
        const entry = db.must('receptions', sessionId);
        requireFact(entry.version === value.expectedVersion, 'STALE_RECEPTION', 'Reception version changed');
        if (value.enabled === true && !entry.enabled) {
          requireFact(db.find('receptions', item => item.enabled).length < service.config.maxReceptions,
            'RECEPTION_LIMIT', 'Configured reception limit reached');
          requireFact(!db.find('bindings', binding => binding.sessionId === sessionId).length,
            'INTERNAL_TARGET', 'Internal role session cannot be enabled as a reception');
        }
        if (value.enabled !== undefined && value.enabled !== entry.enabled
          || value.kind !== undefined && value.kind !== entry.kind) entry.generation++;
        const { requestId: _requestId, expectedVersion: _expectedVersion, ...changes } = value;
        Object.assign(entry, changes);
        entry.version++;
        db.put('receptions', entry);
        service.changed();
        if (entry.enabled) wake(sessionId);
        return entry;
      });
    }),
    api('POST', '/receptions/:id/recover', async request => {
      const sessionId = pathSchema.parse(request.params).id;
      const value = recoverSchema.parse(request.body);
      const result = await runtime.recoverHistory(sessionId, value.requestId, value.maxPages, value.evidence);
      wake(sessionId);
      return result;
    }),
    api('POST', '/risk/suppress', request => {
      const value = suppressSchema.parse(request.body);
      return mutate('suppress', value.requestId, value, () => {
        const risk = db.must('risks', value.sessionId);
        requireFact(risk.signature === value.signature, 'STALE_RISK', 'Shared-context risk signature changed');
        risk.suppressed = true;
        db.put('risks', risk);
        service.changed();
        return { ...risk, evidence: value.evidence };
      });
    }),
    api('POST', '/effects/:id/resolve', request => {
      const effectId = operationPathSchema.parse(request.params).id;
      return resolve(effectId, resolveSchema.parse(request.body));
    }),
    api('POST', '/effects/:id/retry', request => {
      const effectId = pathSchema.parse(request.params).id;
      const value = retrySchema.parse(request.body);
      return mutate('retry', value.requestId, { effectId, ...value }, () => {
        const original = db.must('deliveries', effectId);
        requireFact(original.kind === 'wake' && original.state === 'rejected',
          'WAKE_RETRY_ONLY', 'Only explicitly rejected internal wakes can be retried');
        requireFact(db.find('bindings', binding => binding.sessionId === original.sessionId
          && binding.epoch === original.roleEpoch && binding.ready).length === 1,
        'STALE_ROLE', 'Wake no longer belongs to a ready current role session and epoch');
        requireFact(!db.meta<string | null>(`wakeRetry:${effectId}`, null),
          'WAKE_ALREADY_RETRIED', 'This rejected wake already has a successor; inspect that delivery instead');
        const retry: Delivery = { ...original, id: `wake:retry:${randomUUID()}`, state: 'pending',
          requestId: null, createdAt: service.now(), error: null,
          result: { retryOf: original.id, evidence: value.evidence, requestId: value.requestId } };
        db.put('deliveries', retry);
        db.setMeta(`wakeRetry:${effectId}`, retry.id);
        service.publish({ type: 'status', text: `Explicit wake retry ${retry.id} replaces rejected delivery ${original.id}. Evidence: ${value.evidence}` });
        service.changed();
        return retry;
      });
    }),
    api('POST', '/operations/:id/resolve', request => resolve(operationPathSchema.parse(request.params).id, {
      ...operationResolveSchema.parse(request.body), target: 'operation',
    })),
    api('POST', '/messages/:id/correct', request => {
      const messageId = pathSchema.parse(request.params).id;
      const value = correctionSchema.parse(request.body);
      return recorded('correct', value.requestId, { messageId, ...value },
        () => service.correct(messageId, value.text, value.expectedVersion, value.reason));
    }),
    api('POST', '/messages/:id/reclassify', request => {
      const messageId = pathSchema.parse(request.params).id;
      const value = classifySchema.parse(request.body);
      return mutate('reclassify', value.requestId, { messageId, ...value }, () => {
        const message = db.must('messages', messageId);
        requireFact(message.version === value.expectedVersion && message.assignmentVersion === value.expectedAssignmentVersion,
          'STALE_INPUT', 'Message content or classification changed');
        const unfinished = db.find('work', w => w.messageId === message.id && (w.state === 'pending' || w.state === 'leased'));
        const decided = db.find('work', w => w.messageId === message.id && w.state === 'done').length > 0;
        const topic = service.classify(message, value.topic, value.reason);
        if (unfinished.length && !decided) service.addWork(message);
        service.publish({ type: 'correction', messageId, topicId: topic.id, text: value.reason, sources: [ref(message)] });
        service.changed();
        return { message, topic };
      });
    }),
    api('POST', '/wake', request => {
      const value = requestSchema.parse(request.body);
      return recorded('wake', value.requestId, value, async () => {
        await runtime.wake();
        return { completed: true, stateVersion: service.version };
      });
    }),
    {
      method: 'POST', path: '/mcp', body: 'json', bodyLimit: 2_000_000,
      async handler(request): Promise<ModuleResponse> {
        const json = (body: unknown, status = 200): ModuleResponse => ({ status, headers: jsonHeaders, body });
        const invalid = (code: number, message: string, rpcId: string | number | null = null): ModuleResponse =>
          json({ jsonrpc: '2.0', id: rpcId, error: { code, message } });
        const parsed = rpcSchema.safeParse(request.body);
        if (!parsed.success) return invalid(-32600, 'Invalid JSON-RPC request');
        const rpc = parsed.data;
        const requestedProtocol = request.headers['mcp-protocol-version'];
        if (requestedProtocol !== undefined && (typeof requestedProtocol !== 'string'
          || !protocols.some(protocol => protocol === requestedProtocol))) {
          return json({ error: { code: 'UNSUPPORTED_PROTOCOL', message: 'Unsupported MCP protocol version' } }, 400);
        }
        if (rpc.id === undefined) return { status: 202 };
        const success = (result: unknown): ModuleResponse => json({ jsonrpc: '2.0', id: rpc.id, result });
        try {
          switch (rpc.method) {
            case 'initialize': {
              const value = initializeSchema.parse(rpc.params);
              const protocolVersion = protocols.find(protocol => protocol === value.protocolVersion) ?? protocols[0];
              return success({ protocolVersion, capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'cockpit-assistant', version: '0.1.0' }, jsonSchemaDialect: dialect,
                instructions: 'Use your ready bound main role epoch. Claim durable work, read the source and state, then submit a structured role result. Never supply identity in tool arguments.' });
            }
            case 'ping': emptyParams.parse(rpc.params ?? {}); return success({});
            case 'tools/list':
              emptyParams.parse(rpc.params ?? {});
              return success({ tools: toolDefinitions.map(tool => ({ name: tool.name, description: tool.description,
                inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-2020-12' }) })) });
            case 'tools/call': {
              let name: string;
              try {
                const call = callSchema.parse(rpc.params);
                name = call.name;
                const identity = identitySchema.parse(call._meta?.['cockpit/invocation']);
                let output: unknown;
                switch (name) {
                  case 'assistant_read': {
                    const value = roleReadSchema.parse(call.arguments);
                    await runtime.authorize(identity, value.role, value.epoch);
                    output = roleRead(identity, value);
                    break;
                  }
                  case 'assistant_claim': {
                    const value = claimSchema.parse(call.arguments);
                    await runtime.authorize(identity, value.role, value.epoch);
                    output = service.claim(identity, value.role, value.epoch, value.workId);
                    wake();
                    break;
                  }
                  case 'assistant_decide': {
                    const value = decisionSchema.parse(call.arguments);
                    await runtime.authorize(identity, 'coordinator', value.epoch);
                    output = service.decide(identity, value);
                    wake();
                    break;
                  }
                  case 'assistant_create_session': {
                    output = await createTopicSession(service, runtime, identity, call.arguments);
                    wake();
                    break;
                  }
                  case 'assistant_remember': {
                    const value = rememberSchema.parse(call.arguments);
                    await runtime.authorize(identity, 'memory', value.epoch);
                    output = service.remember(identity, value);
                    wake();
                    break;
                  }
                  default: return invalid(-32602, 'Unknown Assistant tool', rpc.id);
                }
                return success({ content: [{ type: 'text', text: JSON.stringify(output) }], isError: false });
              } catch (error) {
                const known = knownError(error);
                if (!known) throw error;
                return success({ content: [{ type: 'text', text: JSON.stringify({ error: known }) }], isError: true });
              }
            }
            default: return invalid(-32601, 'Method not found', rpc.id);
          }
        } catch (error) {
          if (error instanceof z.ZodError) return invalid(-32602, 'Invalid method parameters', rpc.id);
          throw error;
        }
      },
    },
  );
  return result;
}

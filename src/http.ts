import { z } from 'zod';
import type { McpInvocationMeta, ModuleRequest, ModuleResponse, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { BusinessError, requireFact } from './errors.ts';
import type { Runtime } from './runtime.ts';
import type { AssistantService } from './service.ts';
import { publicationStream } from './stream.ts';
import { inputReceipt, timeline, timelineItem } from './ui.ts';
import { activateRolesSchema, attributionSchema, bindingSchema, claimSchema, clarificationSchema,
  configSchema, createSessionSchema, dispatchSchema, historySchema, id, inputSchema,
  mappingSchema, pageSchema, rememberSchema, roleReadSchema, topicSchema } from './schema.ts';
import type { Table } from './types.ts';
import { primary } from './ingestion.ts';

const integerQuery = z.union([z.int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.int().nonnegative());
const queryPage = z.strictObject({
  after: integerQuery.default(0), limit: integerQuery.pipe(z.number().min(1).max(100)).default(50),
});
const pathSchema = z.strictObject({ id: z.string().min(1).max(512) });
const empty = z.strictObject({});
const streamQuery = z.strictObject({ after: integerQuery.optional() });
const timelineQuery = z.strictObject({
  before: integerQuery.optional(), after: integerQuery.optional(),
  limit: integerQuery.pipe(z.number().min(1).max(100)).optional(),
}).refine(value => value.before === undefined || value.after === undefined, 'before and after are mutually exclusive');
const identitySchema = z.object({
  sessionId: id, runtimeSessionId: id, subagent: z.boolean(), agentName: id.optional(), toolCallId: id.optional(),
});
const metaSchema = z.record(z.string(), z.unknown());
const rpcSchema = z.strictObject({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1), params: z.unknown().optional(),
});
const initializeSchema = z.strictObject({
  protocolVersion: z.string().min(1), capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough(), _meta: metaSchema.optional(),
});
const callSchema = z.strictObject({ name: z.string(), arguments: z.unknown().optional(), _meta: metaSchema.optional() });
const emptyParams = z.strictObject({ _meta: metaSchema.optional() });
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const toolDefinitions = [
  { name: 'assistant_topics', schema: pageSchema, description: 'Read flat topics, their content and current session mappings. Read only the relevant page; no work claims.' },
  { name: 'assistant_topic', schema: topicSchema, description: 'Create or update a flat topic definition. Return value contains its stable ID. New topic does not create a session. Reuse an existing topic for ordinary details.' },
  { name: 'assistant_map', schema: mappingSchema, description: 'Set the current ordinary session for a topic, or clear it. One topic has at most one current session; a session may handle several topics. No automatic history migration.' },
  { name: 'assistant_sessions', schema: pageSchema, description: 'Read observed ordinary sessions and their availability. Unloaded or busy sessions are not missing and need no replacement.' },
  { name: 'assistant_history', schema: historySchema, description: 'Passively review one bounded page of an ordinary session history when needed for topic or mapping decisions. Does not load or send a prompt.' },
  { name: 'assistant_dispatch', schema: dispatchSchema, description: 'Submit all new Assistant user requests in this batch together as an array of {topicId,prompt}. Prompts faithfully split user intent without adding authorization. Service creates/loads/queues targets and retains attachments. For an attributed native question, prompt is the user answer verbatim, respecting exact choices; never bypass or paraphrase. Do not resend ordinary Chat inputs.' },
  { name: 'assistant_attribute', schema: attributionSchema, description: 'Associate original session replies in the current batch with their actual topic. Replies are already displayed; this only adds a topic header. No rewriting, quality gate, suppression or re-answer request. A new topic may reuse the source session.' },
  { name: 'assistant_clarify', schema: clarificationSchema, description: 'Ask one brief question only for a genuinely ambiguous recipient or explain an actual native answer constraint. Not a business authorization review. Original inputs remain saved.' },
  { name: 'assistant_memory_read', schema: roleReadSchema, description: 'Memory only: read bounded topic and exact versioned sources for the claimed memory work.' },
  { name: 'assistant_memory_claim', schema: claimSchema, description: 'Memory only: claim source-bound extraction work. Drain until null, then stop. Coordinator never uses this protocol.' },
  { name: 'assistant_remember', schema: rememberSchema, description: 'Memory only: commit source-bound confirmed, reported or inferred entries using the current memory proof.' },
];
function knownError(error: unknown) {
  if (error instanceof BusinessError) return { code: error.code, message: error.message, status: error.status };
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: 'Request validation failed', status: 400, issues: error.issues };
  return null;
}

export function routes(service: AssistantService, runtime: Runtime): ModuleRoute[] {
  const { db } = service;
  const wake = () => { void Promise.resolve().then(() => runtime.wake()).catch(error => runtime.report(error)); };
  const api = (method: ModuleRoute['method'], path: string,
    action: (request: ModuleRequest) => unknown | Promise<unknown>): ModuleRoute => ({
    method, path, ...(method === 'GET' ? {} : { body: 'json' as const, bodyLimit: 2_000_000 }),
    async handler(request): Promise<ModuleResponse> {
      try {
        if (method !== 'GET') empty.parse(request.query);
        const body = await action(request);
        if (method !== 'GET') wake();
        return { headers: jsonHeaders, body };
      } catch (error) {
        const known = knownError(error);
        if (!known) throw error;
        return { status: known.status, headers: jsonHeaders, body: { error: known } };
      }
    },
  });
  const memoryRead = (identity: McpInvocationMeta, value: z.infer<typeof roleReadSchema>): unknown => {
    service.authorize(identity, 'memory', value.epoch);
    const work = db.must('work', value.workId);
    requireFact(service.activeBatch('memory')?.workIds.includes(work.id),
      'SOURCE_SCOPE', 'Read only source work supplied to this memory batch', 403);
    requireFact(work.role === 'memory' && work.epoch === value.epoch && work.state === 'leased'
      && work.leaseUntil > service.now(), 'STALE_LEASE', 'Memory work is not currently leased', 403);
    const sources = new Map(work.sources.map(source => [source.messageId, source]));
    for (const source of sources.values()) {
      const message = db.must('messages', source.messageId);
      requireFact(message.version === source.version && message.assignmentVersion === source.assignmentVersion,
        'STALE_SOURCE', 'Memory source changed');
    }
    const page = db.list(value.resource, value.after, value.limit);
    return { ...page, items: page.items.filter(item => value.resource === 'work' ? item.id === work.id
      : value.resource === 'topics' ? item.id === work.topicId
        : value.resource === 'messages' ? sources.has(item.id)
          : 'topicId' in item && item.topicId === work.topicId && 'valid' in item && item.valid) };
  };
  const result: ModuleRoute[] = [
    api('GET', '/state', request => {
      empty.parse(request.query);
      return { config: service.config, roles: db.list('bindings', 0, 2).items, publicationCursor: db.meta('publicationSequence', 0) };
    }),
    api('GET', '/timeline', request => {
      const { before, after, limit } = timelineQuery.parse(request.query);
      return timeline(service, before, after, limit ?? (after === undefined ? 50 : 100));
    }),
    api('GET', '/timeline/items/:sequence', request => {
      empty.parse(request.query);
      const { sequence } = z.strictObject({ sequence: integerQuery.pipe(z.number().positive()) }).parse(request.params);
      const publication = db.publication(sequence);
      requireFact(publication, 'NOT_FOUND', 'Publication not found', 404);
      return timelineItem(service, publication);
    }),
    api('GET', '/readiness', request => { empty.parse(request.query); return runtime.readiness(); }),
    api('GET', '/sessions/:id/inspect', request => {
      empty.parse(request.query); return runtime.inspect(pathSchema.parse(request.params).id);
    }),
    api('POST', '/sessions/:id/history/recover', request => {
      const sessionId = pathSchema.parse(request.params).id;
      const value = z.strictObject({ requestId: id, maxPages: z.int().min(1).max(10),
        evidence: z.string().trim().min(1).max(4000) }).parse(request.body);
      return runtime.recoverHistory(sessionId, value.requestId, value.maxPages, value.evidence);
    }),
    api('GET', '/operations/:id', request => {
      empty.parse(request.query); return db.must('operations', pathSchema.parse(request.params).id);
    }),
    api('GET', '/inputs/:requestId', request => {
      empty.parse(request.query);
      return inputReceipt(service, z.strictObject({ requestId: id }).parse(request.params).requestId);
    }),
    api('POST', '/messages', request => runtime.acceptReady(inputSchema.parse(request.body))),
    api('POST', '/roles/activate', request => runtime.activateRoles(activateRolesSchema.parse(request.body))),
    api('POST', '/roles/bind', request => runtime.bind(bindingSchema.parse(request.body))),
    api('POST', '/sessions', request => runtime.create(createSessionSchema.parse(request.body))),
    api('PATCH', '/config', request => {
      const value = z.strictObject({ requestId: id, config: configSchema }).parse(request.body);
      return db.transaction(() => service.idempotent(`config:${value.requestId}`, value, () => {
        db.setMeta('config', value.config); return value.config;
      }));
    }),
  ];
  for (const table of ['topics', 'messages', 'receptions', 'questions', 'deliveries', 'operations', 'memories'] as Table[])
    result.push(api('GET', `/${table}`, request => {
      const value = queryPage.parse(request.query);
      return db.list(table, value.after, value.limit);
    }));
  result.push({
    method: 'GET', path: '/timeline/stream',
    handler(request): ModuleResponse {
      try {
        const value = streamQuery.parse(request.query);
        const last = integerQuery.optional().parse(request.headers['last-event-id']);
        return publicationStream(service, last ?? value.after ?? 0, request.signal,
          publication => timelineItem(service, publication));
      } catch (error) {
        const known = knownError(error);
        if (!known) throw error;
        return { status: known.status, headers: jsonHeaders, body: { error: known } };
      }
    },
  }, {
    method: 'POST', path: '/mcp', body: 'json', bodyLimit: 2_000_000,
    async handler(request): Promise<ModuleResponse> {
      const json = (body: unknown, status = 200): ModuleResponse => ({ status, headers: jsonHeaders, body });
      const invalid = (code: number, message: string, rpcId: string | number | null = null) =>
        json({ jsonrpc: '2.0', id: rpcId, error: { code, message } });
      const parsed = rpcSchema.safeParse(request.body);
      if (!parsed.success) return invalid(-32600, 'Invalid JSON-RPC request');
      const rpc = parsed.data;
      const protocol = request.headers['mcp-protocol-version'];
      if (protocol !== undefined && (typeof protocol !== 'string' || !protocols.some(p => p === protocol)))
        return json({ error: { code: 'UNSUPPORTED_PROTOCOL', message: 'Unsupported MCP protocol version' } }, 400);
      if (rpc.id === undefined) return { status: 202 };
      const success = (output: unknown) => json({ jsonrpc: '2.0', id: rpc.id, result: output });
      try {
        switch (rpc.method) {
          case 'initialize': {
            const value = initializeSchema.parse(rpc.params);
            return success({ protocolVersion: protocols.find(p => p === value.protocolVersion) ?? protocols[0],
              capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cockpit-assistant', version: '2' },
              jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
              instructions: 'Coordinator receives original source batches and uses topic, mapping, dispatch and attribution tools. Memory has separate source-bound extraction tools.' });
          }
          case 'ping': emptyParams.parse(rpc.params ?? {}); return success({});
          case 'tools/list':
            emptyParams.parse(rpc.params ?? {});
            return success({ tools: toolDefinitions.map(tool => ({ name: tool.name, description: tool.description,
              inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-2020-12' }) })) });
          case 'tools/call': {
            try {
              const call = callSchema.parse(rpc.params);
              const identity = identitySchema.parse(call._meta?.['cockpit/invocation']);
              const memory = ['assistant_memory_read', 'assistant_memory_claim', 'assistant_remember'].includes(call.name);
              if (!toolDefinitions.some(tool => tool.name === call.name)) return invalid(-32602, 'Unknown Assistant tool', rpc.id);
              await runtime.authorize(identity, memory ? 'memory' : 'coordinator');
              let output: unknown;
              switch (call.name) {
                case 'assistant_topics': {
                  const page = pageSchema.parse(call.arguments ?? {});
                  const topics = db.list('topics', page.after, page.limit);
                  output = { ...topics, items: topics.items.map(topic => ({
                    topicId: topic.id, title: topic.title, content: topic.content,
                    sessionId: topic.sessionId, archived: topic.archived,
                  })) }; break;
                }
                case 'assistant_sessions': {
                  const page = pageSchema.parse(call.arguments ?? {});
                  const entries = db.list('receptions', page.after, page.limit);
                  output = { ...entries, items: entries.items.filter(item => item.enabled
                    && !db.find('bindings', binding => binding.sessionId === item.id).length)
                    .map(item => ({ sessionId: item.id, title: item.label, availability: item.availability })) }; break;
                }
                case 'assistant_history': {
                  const value = historySchema.parse(call.arguments);
                  service.reception(value.sessionId, true);
                  const history = await runtime.native.host.call('session/chat', {
                    sessionId: value.sessionId, source: 'persisted', direction: 'backward', max: 16, bootstrap: false, waitMs: 0,
                    ...(value.cursor ? { cursor: value.cursor } : {}),
                  });
                  output = { sessionId: value.sessionId, cursor: history.cursor, hasMore: history.hasMore,
                    events: history.events.filter(event => !event.ephemeral && primary(event)
                      && ['user.message', 'assistant.message'].includes(event.type))
                      .map(event => ({ id: event.id, type: event.type, content: event.data.content,
                        ...(event.data.attachments ? { attachments: event.data.attachments } : {}) })) };
                  break;
                }
                case 'assistant_topic': {
                  const topic = service.topic(identity, call.arguments);
                  output = { topicId: topic.id, version: topic.version }; break;
                }
                case 'assistant_map': {
                  const topic = service.map(identity, call.arguments);
                  output = { topicId: topic.id, sessionId: topic.sessionId, version: topic.version }; break;
                }
                case 'assistant_dispatch': output = service.dispatch(identity, call.arguments); break;
                case 'assistant_attribute': output = service.attribute(identity, call.arguments); break;
                case 'assistant_clarify': output = service.clarify(identity, call.arguments); break;
                case 'assistant_memory_read': output = memoryRead(identity, roleReadSchema.parse(call.arguments)); break;
                case 'assistant_memory_claim': {
                  const value = claimSchema.parse(call.arguments);
                  output = service.claim(identity, 'memory', value.epoch, value.workId); break;
                }
                case 'assistant_remember': {
                  service.remember(identity, call.arguments);
                  const remaining = service.activeBatch('memory')?.workIds
                    .filter(id => ['pending', 'leased'].includes(db.must('work', id).state)).length ?? 0;
                  output = { saved: true, remaining }; break;
                }
              }
              wake();
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
  });
  return result;
}

import { z } from 'zod';
import type { ModuleRequest, ModuleResponse, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { BusinessError, requireFact } from './errors.ts';
import type { Runtime } from './runtime.ts';
import type { AssistantService } from './service.ts';
import { publicationStream } from './stream.ts';
import { inputReceipt, timeline, timelineItem } from './ui.ts';
import { activateRolesSchema, bindingSchema, clarificationSchema, completeSchema, configSchema,
  createSessionSchema, historySchema, id, inputSchema, pageSchema, sourceSchema } from './schema.ts';
import { internal, primary } from './ingestion.ts';
import { withRoleMetadata } from './native.ts';

const integer = z.union([z.int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.int().nonnegative());
const queryPage = z.strictObject({ after: integer.default(0), limit: integer.pipe(z.number().min(1).max(100)).default(50) });
const empty = z.strictObject({});
const timelineQuery = z.strictObject({ before: integer.optional(), after: integer.optional(),
  limit: integer.pipe(z.number().min(1).max(100)).optional() })
  .refine(v => v.before === undefined || v.after === undefined, 'before and after are mutually exclusive');
const identitySchema = z.object({ sessionId: id, runtimeSessionId: id, subagent: z.boolean(),
  agentName: id.optional(), toolCallId: id.optional() });
const metaSchema = z.record(z.string(), z.unknown());
const rpcSchema = z.strictObject({ jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number().finite(), z.null()]).optional(), method: z.string().min(1), params: z.unknown().optional() });
const initializeSchema = z.strictObject({ protocolVersion: z.string().min(1), capabilities: metaSchema,
  clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough(), _meta: metaSchema.optional() });
const callSchema = z.strictObject({ name: z.string(), arguments: z.unknown().optional(), _meta: metaSchema.optional() });
const emptyParams = z.strictObject({ _meta: metaSchema.optional() });
const protocols = ['2025-11-25','2025-06-18','2025-03-26'] as const;
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const tools = [
  { name: 'assistant_topics', schema: pageSchema, description: 'Read a bounded page of flat topic definitions and current native session mappings.' },
  { name: 'assistant_sessions', schema: pageSchema, description: 'Read ordinary Host sessions, with their actual availability. This is not a persistent session mirror.' },
  { name: 'assistant_history', schema: historySchema, description: 'Read one bounded ordinary native chat page and that one session’s actual current native ask on demand. currentAskTopicIds comes only from saved associations, not a guess. Passive reading is not ingestion; never arbitrate historical asks.' },
  { name: 'assistant_source', schema: sourceSchema, description: 'Read one exact saved original by messageId, with native question and local clarification history, when relevant to the current source. This is a bounded passive read, not ingestion or a grant to mutate another original.' },
  { name: 'assistant_complete', schema: completeSchema, description: 'Atomically save the complete semantic result for ONE messageId. topics defines/updates affected topics (choose an explicit stable topicId for a new topic); items contains {topicId,prompt} for user originals, {topicId} for native replies/questions. No copied native body. All definitions, mapping edits, associations and processed=true commit together before delivery. New reply topics default to the source session. Existing topics do not adopt a different speaker. Explicit handoff must name a real target session in the original. Saved does not imply native delivery completed.' },
  { name: 'assistant_clarify', schema: clarificationSchema, description: 'Put one local question on the current exact original, leaving it unprocessed. Optional choices/freeform. The UI, not a native ask callback, collects an answer; other eligible originals can proceed. Stop this invocation afterward.' },
];
function knownError(error: unknown) {
  if (error instanceof BusinessError) return { code: error.code, message: error.message, status: error.status };
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: 'Request validation failed', status: 400, issues: error.issues };
  return null;
}
export function routes(service: AssistantService, runtime: Runtime): ModuleRoute[] {
  const { db } = service;
  const wake = () => { void Promise.resolve().then(() => runtime.wake()).catch(runtime.report); };
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
  const result: ModuleRoute[] = [
    api('GET', '/state', async request => {
      empty.parse(request.query);
      return { config: service.config, roles: (await runtime.readiness()).roles,
        publicationCursor: db.watermark, timelineProtocol: 'message-snapshots-v1', schemaVersion: 3 };
    }),
    api('GET', '/timeline', request => {
      const value = timelineQuery.parse(request.query);
      return timeline(service, value.before, value.after, value.limit ?? (value.after === undefined ? 50 : 100),
        message => runtime.visibleDiagnostic(message));
    }),
    api('GET', '/timeline/items/:sequence', request => {
      empty.parse(request.query);
      const { sequence } = z.strictObject({ sequence: integer.pipe(z.number().positive()) }).parse(request.params);
      const message = db.find('messages', m => m.sequence === sequence)[0];
      requireFact(message, 'NOT_FOUND', 'Message not found', 404);
      return timelineItem(service, message, runtime.visibleDiagnostic(message));
    }),
    api('GET', '/readiness', request => { empty.parse(request.query); return runtime.readiness(); }),
    api('GET', '/sessions/:id/inspect', request => {
      empty.parse(request.query); return runtime.inspect(z.strictObject({ id }).parse(request.params).id);
    }),
    api('GET', '/operations/:id', request => {
      empty.parse(request.query);
      const operation = runtime.operations.get(z.strictObject({ id }).parse(request.params).id);
      requireFact(operation, 'NOT_FOUND', 'Temporary setup receipt is unavailable; inspect actual Host state, do not recreate blindly', 404);
      return operation;
    }),
    api('GET', '/inputs/:requestId', request => {
      empty.parse(request.query); return inputReceipt(service, z.strictObject({ requestId: id }).parse(request.params).requestId);
    }),
    api('POST', '/messages', request => runtime.acceptReady(inputSchema.parse(request.body))),
    api('POST', '/roles/activate', request => runtime.activateRoles(activateRolesSchema.parse(request.body))),
    api('POST', '/roles/bind', request => runtime.bind(bindingSchema.parse(request.body))),
    api('POST', '/sessions', request => runtime.create(createSessionSchema.parse(request.body))),
    api('PATCH', '/config', request => {
      z.strictObject({ requestId: id, config: configSchema }).parse(request.body);
      requireFact(false, 'HOST_CONFIG_REQUIRED', 'Change configuration through Host module configuration; no public persistent config-write API exists');
    }),
  ];
  for (const method of ['GET','POST'] as const) result.push(api(method,
    '/messages/:messageId/clarifications/:clarificationId', request => {
      if (method === 'GET') empty.parse(request.query);
      const p = z.strictObject({ messageId: id, clarificationId: id }).parse(request.params);
      return method === 'GET' ? service.clarification(p.messageId, p.clarificationId)
        : service.answerClarification(p.messageId, p.clarificationId, request.body);
    }));
  for (const [resource, table] of [['topics','topics'],['messages','messages'],['topic-messages','topic_messages']] as const)
    result.push(api('GET', `/${resource}`, request => {
      const page = queryPage.parse(request.query); return db.list(table, page.after, page.limit);
    }));
  result.push(api('GET', '/receptions', async request => {
    const page = queryPage.parse(request.query), items = (await runtime.readiness()).receptions;
    return { items: items.slice(page.after, page.after + page.limit),
      cursor: Math.min(items.length, page.after + page.limit), hasMore: items.length > page.after + page.limit };
  }));
  result.push({
    method: 'GET', path: '/timeline/stream',
    handler(request): ModuleResponse {
      try {
        const value = z.strictObject({ after: integer.optional() }).parse(request.query);
        const last = integer.optional().parse(request.headers['last-event-id']);
        return publicationStream(service, last ?? value.after ?? 0, request.signal,
          message => timelineItem(service, message, runtime.visibleDiagnostic(message)));
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
      const rpc = parsed.data, protocol = request.headers['mcp-protocol-version'];
      if (protocol !== undefined && (typeof protocol !== 'string' || !protocols.some(p => p === protocol)))
        return json({ error: { code: 'UNSUPPORTED_PROTOCOL', message: 'Unsupported MCP protocol version' } }, 400);
      if (rpc.id === undefined) return { status: 202 };
      const success = (output: unknown) => json({ jsonrpc: '2.0', id: rpc.id, result: output });
      try {
        switch (rpc.method) {
          case 'initialize': {
            const value = initializeSchema.parse(rpc.params);
            return success({ protocolVersion: protocols.find(p => p === value.protocolVersion) ?? protocols[0],
              capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cockpit-assistant', version: '3' },
              jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
              instructions: 'Coordinator handles one original at a time; assistant_complete saves its entire result, or assistant_clarify asks locally. No memory or work claims.' });
          }
          case 'ping': emptyParams.parse(rpc.params ?? {}); return success({});
          case 'tools/list':
            emptyParams.parse(rpc.params ?? {});
            return success({ tools: tools.map(tool => ({ name: tool.name, description: tool.description,
              inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-2020-12' }) })) });
          case 'tools/call': {
            try {
              const call = callSchema.parse(rpc.params);
              const identity = identitySchema.parse(call._meta?.['cockpit/invocation']);
              requireFact(tools.some(tool => tool.name === call.name), 'UNKNOWN_TOOL', 'Unknown or retired Assistant tool', 400);
              let output: unknown;
              if (call.name === 'assistant_complete') {
                const result = await runtime.complete(identity, call.arguments);
                output = { saved: result.saved, alreadyProcessed: result.alreadyProcessed,
                  messageId: result.message.id, processed: result.message.processed, topicMessages: result.topicMessages };
              }
              else if (call.name === 'assistant_clarify') output = await runtime.clarify(identity, call.arguments);
              else {
                const sourceId = call.name === 'assistant_source' ? sourceSchema.parse(call.arguments).messageId : undefined;
                await runtime.authorize(identity);
                switch (call.name) {
                  case 'assistant_source': output = service.source(sourceId!); break;
                  case 'assistant_topics': {
                    const page = pageSchema.parse(call.arguments ?? {});
                    const topics = db.list('topics', page.after, page.limit);
                    output = { ...topics, items: topics.items.map(topic => ({ topicId: topic.id,
                      title: topic.title, content: topic.content, archived: topic.archived, version: topic.version,
                      sessionId: topic.sessionId, mappingState: topic.mappingState,
                      mappingError: topic.mappingError, creationReceipt: topic.creationReceipt })) }; break;
                  }
                  case 'assistant_sessions': {
                    const page = pageSchema.parse(call.arguments ?? {}), sessions = (await runtime.readiness()).receptions;
                    output = { items: sessions.slice(page.after, page.after + page.limit).map(session =>
                      ({ sessionId: session.id, title: session.label, availability: session.availability })),
                      cursor: Math.min(sessions.length, page.after + page.limit), hasMore: sessions.length > page.after + page.limit }; break;
                  }
                  case 'assistant_history': {
                    const value = historySchema.parse(call.arguments);
                    const response = await runtime.native.host.call('session/get', { sessionId: value.sessionId });
                    const meta = response.meta ? await withRoleMetadata(runtime.native.host, response.meta) : null;
                    requireFact(meta && !internal(meta), 'INTERNAL_HISTORY', 'History reads require an ordinary native session', 403);
                    const history = await runtime.native.host.call('session/chat', { sessionId: value.sessionId,
                      source: 'persisted', direction: 'backward', max: 16, bootstrap: false, waitMs: 0,
                      ...(value.cursor ? { cursor: value.cursor } : {}) });
                    const currentQuestion = meta.ask ? db.nativeQuestion(value.sessionId, meta.ask.requestId) : undefined;
                    output = { sessionId: value.sessionId, cursor: history.cursor, hasMore: history.hasMore,
                      currentAsk: meta.ask, currentAskTopicIds: currentQuestion
                        ? db.topicMessages(currentQuestion.id).map(row => row.topicId) : [],
                      events: history.events.filter(event => !event.ephemeral && primary(event)
                        && ['user.message','assistant.message'].includes(event.type))
                        .map(event => ({ id: event.id, type: event.type, content: event.data.content,
                          ...(event.data.attachments ? { attachments: event.data.attachments } : {}) })) };
                    break;
                  }
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

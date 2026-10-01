import { z } from 'zod';
import type { ModuleRequest, ModuleResponse, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { Assistant, dispatchInput, historyInput, inboxInput, pageInput, topicInput } from './core.ts';
import { BusinessError } from './errors.ts';

export const tools = [
  { name: 'assistant_topics', schema: pageInput, description: 'Read the current flat topic register. This does not dispatch or read session history.' },
  { name: 'assistant_topic', schema: topicInput, description: 'Manage a topic or register its existing worker. For a new topic omit topicId and retain the actual returned ID. Only a genuine user request permits changes; a result reminder does not.' },
  { name: 'assistant_dispatch', schema: dispatchInput, description: 'Deliver the whole faithful split of the current genuine user request to topic workers. The service owns creation/load/queue/answers. Never dispatch from a result reminder or add business follow-ups. A native ask answer must be one complete original user message, not a model paraphrase or extracted choice.' },
  { name: 'assistant_inbox', schema: inboxInput, description: 'Read and atomically consume unread worker replies. Optional ids select entries; limit bounds the read. peek:true only counts. Reading clears the returned temporary copies immediately; source histories remain available. Do not use a presentation declaration or ACK.' },
  { name: 'assistant_history', schema: historyInput, description: 'Passively read native history without loading or changing the source. Organizer defaults to recent:true: the latest three nonempty primary user/assistant bodies, bounded text with explicit truncation and sample completeness, no tools or internal metadata. Use this for topic preparation, not full-history coverage. recent:false preserves native cursor pages; the foreground defaults to that original view. Recent sampling does not accept a cursor. Does not enroll, resend or copy history into the inbox.' },
  { name: 'assistant_status', schema: z.strictObject({ topicId: z.string().min(1).max(200) }), description: 'Inspect the topic and actual native worker state. Acceptance, a reply and idle do not establish business completion.' },
];
export const coordinatorTools = tools.map(tool => tool.name);
const meta = z.record(z.string(), z.unknown());
const rpcSchema = z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1), params: z.unknown().optional() });
const callSchema = z.strictObject({ name: z.string(), arguments: z.unknown().optional(), _meta: meta.optional() });
const identitySchema = z.object({ sessionId: z.string().min(1), runtimeSessionId: z.string().min(1),
  subagent: z.boolean(), toolCallId: z.string().min(1) });
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26'];
const json = (body: unknown, status = 200): ModuleResponse =>
  ({ status, headers: { 'content-type': 'application/json' }, body });
const known = (error: unknown) => error instanceof BusinessError
  ? { code: error.code, message: error.message, status: error.status }
  : error instanceof z.ZodError ? { code: 'INVALID_INPUT', message: 'Invalid arguments', issues: error.issues } : null;

export function mcp(assistant: Assistant): ModuleRoute {
  return { method: 'POST', path: '/mcp', body: 'json', bodyLimit: 2_000_000,
    async handler(request: ModuleRequest): Promise<ModuleResponse> {
      const parsed = rpcSchema.safeParse(request.body);
      if (!parsed.success) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
      const rpc = parsed.data;
      const protocol = request.headers['mcp-protocol-version'];
      if (protocol !== undefined && (typeof protocol !== 'string' || !protocols.includes(protocol)))
        return json({ error: 'Unsupported MCP protocol version' }, 400);
      if (rpc.id === undefined) return { status: 202 };
      const ok = (result: unknown) => json({ jsonrpc: '2.0', id: rpc.id, result });
      try {
        if (rpc.method === 'initialize') {
          const input = z.object({ protocolVersion: z.string().min(1), capabilities: meta,
            clientInfo: z.object({ name: z.string(), version: z.string() }) }).parse(rpc.params);
          return ok({ protocolVersion: protocols.includes(input.protocolVersion) ? input.protocolVersion : protocols[0],
            capabilities: { tools: {} }, serverInfo: { name: 'cockpit-assistant', version: '5' },
            instructions: 'Use native Chat. Manage topics, faithfully dispatch genuine user requests, consume unread results, and consult native history. Notices are not business requests; do not add work or answer for the user.' });
        }
        if (rpc.method === 'ping' || rpc.method === 'tools/list') {
          z.strictObject({ _meta: meta.optional() }).parse(rpc.params ?? {});
          return ok(rpc.method === 'ping' ? {} : { tools: tools.map(tool => ({ name: tool.name,
            description: tool.description, inputSchema: z.toJSONSchema(tool.schema) })) });
        }
        if (rpc.method !== 'tools/call') return json({ jsonrpc: '2.0', id: rpc.id,
          error: { code: -32601, message: 'Unknown method' } });
        try {
          const input = callSchema.parse(rpc.params);
          const caller = identitySchema.parse(input._meta?.['cockpit/invocation']);
          const result = await assistant.invoke(input.name, input.arguments, caller);
          return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
        } catch (error) {
          const detail = known(error);
          if (!detail) throw error;
          return ok({ content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], isError: true });
        }
      } catch (error) {
        if (error instanceof z.ZodError) return json({ jsonrpc: '2.0', id: rpc.id,
          error: { code: -32602, message: 'Invalid method parameters' } });
        throw error;
      }
    } };
}

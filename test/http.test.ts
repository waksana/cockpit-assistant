import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { McpInvocationMeta, ModuleRequest, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { routes } from '../src/http.ts';
import { fixture, topic, toolIdentity } from './fixtures.ts';

function setup() {
  const f = fixture();
  f.runtime.wake = async () => {};
  const api = routes(f.service, f.runtime);
  const request = async (method: ModuleRoute['method'], path: string, body?: unknown,
    extra: Partial<ModuleRequest> = {}) => {
    const route = api.find(candidate => candidate.method === method && candidate.path === path);
    assert.ok(route, `${method} ${path} exists`);
    return route.handler({ params: {}, query: {}, headers: {}, body, signal: new AbortController().signal, ...extra });
  };
  const rpc = (method: string, params?: unknown, extra: Partial<ModuleRequest> = {}) =>
    request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }, extra);
  const tool = (name: string, args: unknown, identity?: McpInvocationMeta) =>
    rpc('tools/call', { name, arguments: args, _meta: { 'cockpit/invocation': identity ?? toolIdentity(f) } });
  const start = () => {
    const batch = f.service.startBatch(f.db.must('bindings', 'coordinator'))!;
    f.db.put('deliveries', { id: `batch:${batch.id}`, batchId: batch.id, kind: 'wake',
      messageId: null, sessionId: 'coordinator', requestId: null, text: f.service.batchText(batch),
      attachments: [], supplement: null, answerFreeform: null, state: 'accepted', nativeMessageId: `receipt:${batch.id}`,
      result: null, error: null, roleEpoch: 1, createdAt: 0 });
    f.db.setMeta(`consumer:batch:${batch.id}`, { cursor: 'boundary' });
    return batch;
  };
  return { ...f, api, request, rpc, tool, start };
}
function result(response: Awaited<ReturnType<ReturnType<typeof setup>['rpc']>>) {
  return response.body as { result: { isError: boolean; content: { type: string; text: string }[] };
    error?: { code: number; message: string } };
}
function data<T>(response: Awaited<ReturnType<ReturnType<typeof setup>['tool']>>): T {
  const value = result(response).result;
  assert.equal(value.isError, false, JSON.stringify(value));
  return JSON.parse(value.content[0]!.text) as T;
}

test('HTTP accepts original user input and exposes it immediately without topic or reply anchor', async t => {
  const f = setup(); t.after(() => f.close());
  const response = await f.request('POST', '/messages', { requestId: 'one', text: 'Both tasks' });
  assert.equal(response.status, undefined);
  const page = await f.request('GET', '/timeline');
  assert.match(JSON.stringify(page.body), /Both tasks/);
  assert.match(JSON.stringify(page.body), /"topicId":null/);
  for (const field of ['replyTo', 'topicId'])
    assert.equal((await f.request('POST', '/messages', { requestId: field, text: 'Input', [field]: 'x' })).status, 400);
  const receipt = await f.request('GET', '/inputs/:requestId', undefined, { params: { requestId: 'one' } });
  assert.equal((receipt.body as { input: { text: string } }).input.text, 'Both tasks');
});

test('coordinator tool catalog has no retired work, decision, create or wake protocols', async t => {
  const f = setup(); t.after(() => f.close());
  const response = await f.rpc('tools/list', {});
  const tools = (response.body as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;
  const names = tools.map(tool => tool.name);
  for (const retired of ['assistant_claim', 'assistant_read', 'assistant_decide', 'assistant_create_session'])
    assert.ok(!names.includes(retired));
  const dispatch = tools.find(tool => tool.name === 'assistant_dispatch')!;
  assert.deepEqual(Object.keys(dispatch.inputSchema.properties), ['items']);
  assert.doesNotMatch(JSON.stringify(dispatch), /workId|token|epoch|lease|sessionIds|replyTo/);
});

test('MCP uses trusted identity and rejects helper, wrong carrier and missing identity', async t => {
  const f = setup(); t.after(() => f.close());
  assert.equal(result(await f.tool('assistant_topics', {}, { ...f.identities.coordinator, subagent: true })).result.isError, true);
  assert.equal(result(await f.tool('assistant_topics', {}, f.identities.memory)).result.isError, true);
  assert.equal(result(await f.rpc('tools/call', { name: 'assistant_topics', arguments: {} })).result.isError, true);
  f.service.accept({ requestId: 'inspect', text: 'New input' }); f.start();
  assert.equal(result(await f.tool('assistant_topics', {})).result.isError, false);
});

test('single batch tool call creates independent prompt deliveries with concise replay-safe receipt', async t => {
  const f = setup(); t.after(() => f.close());
  topic(f, 'a'); topic(f, 'b', 's2');
  f.service.accept({ requestId: 'input', text: 'A and B' }); f.start();
  const body = { items: [{ topicId: 'a', prompt: 'A' }, { topicId: 'b', prompt: 'B' }] };
  assert.deepEqual(data(await f.tool('assistant_dispatch', body)), { queued: 2 });
  assert.deepEqual(data(await f.tool('assistant_dispatch', body)), { queued: 2 });
  assert.equal(f.db.find('deliveries', d => d.kind === 'prompt').length, 2);
  assert.equal(result(await f.tool('assistant_dispatch', { items: [{ ...body.items[0], token: 'old' }] })).result.isError, true);
});

test('attribution never accepts replacement text and updates an already displayed reply', async t => {
  const f = setup(); t.after(() => f.close());
  topic(f);
  const message = f.service.addMessage({ kind: 'reply', raw: 'Original', sessionId: 's1' });
  f.service.addWork(message); f.start();
  assert.equal(result(await f.tool('assistant_attribute', {
    items: [{ messageId: message.id, topicId: 'topic', text: 'Rewrite' }],
  })).result.isError, true);
  assert.deepEqual(data(await f.tool('assistant_attribute', { items: [{ messageId: message.id, topicId: 'topic' }] })), { updated: 1 });
  assert.equal(f.db.must('messages', message.id).raw, 'Original');
});

test('session history is passive persisted bounded and excludes internal carriers', async t => {
  const f = setup(); t.after(() => f.close());
  f.service.accept({ requestId: 'inspect', text: 'New input' }); f.start();
  data(await f.tool('assistant_history', { sessionId: 's1' }));
  const call = f.calls.find(call => call.name === 'session/chat')!;
  assert.deepEqual(call.body, { sessionId: 's1', source: 'persisted', direction: 'backward', max: 16, bootstrap: false, waitMs: 0 });
  assert.ok(!f.calls.some(call => call.name === 'session/load'));
  assert.equal(result(await f.tool('assistant_history', { sessionId: 'coordinator' })).result.isError, true);
});

test('removed control routes cannot be used as a parallel coordinator protocol', t => {
  const f = setup(); t.after(() => f.close());
  for (const path of ['/focus', '/handoff', '/risk/suppress', '/messages/:id/reclassify', '/wake', '/effects/:id/retry'])
    assert.ok(!f.api.some(route => route.path === path));
});

test('SSE resumes from persisted event sequence and emits attribution patches', async t => {
  const f = setup(); t.after(() => f.close());
  const controller = new AbortController(); t.after(() => controller.abort());
  topic(f);
  const message = f.service.addMessage({ kind: 'reply', raw: 'Reply', sessionId: 's1' });
  f.service.addWork(message); f.start();
  f.service.attribute(f.identities.coordinator, { items: [{ messageId: message.id, topicId: 'topic' }] });
  const response = await f.request('GET', '/timeline/stream', undefined,
    { query: { after: '0' }, headers: { 'last-event-id': '1' }, signal: controller.signal });
  assert.ok(response.body instanceof Readable);
  const iterator = response.body[Symbol.asyncIterator]();
  const frame = String((await iterator.next()).value);
  assert.match(frame, /attribution/);
  assert.match(frame, /topicColor/);
  assert.match(frame, /id: 2/);
  controller.abort(); await iterator.return?.();
});

test('strict JSON-RPC negotiation and input errors remain explicit', async t => {
  const f = setup(); t.after(() => f.close());
  assert.equal(result(await f.rpc('unknown', {})).error?.code, -32601);
  assert.equal(result(await f.rpc('ping', { extra: true })).error?.code, -32602);
  assert.equal((await f.rpc('ping', {}, { headers: { 'mcp-protocol-version': 'invalid' } })).status, 400);
  const init = await f.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal((init.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
  assert.equal((await f.request('GET', '/timeline', undefined, { query: { before: '1', after: '2' } })).status, 400);
  assert.equal((await f.request('POST', '/messages', { requestId: 'bad', text: '' })).status, 400);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModuleRequest } from '@waksana/cockpit-module-sdk/backend';
import { routes } from '../src/http.ts';
import { fixture, toolIdentity, topic } from './fixtures.ts';

function client(f: ReturnType<typeof fixture>) {
  const table = routes(f.service, f.runtime), signal = new AbortController().signal;
  return async (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown,
    params: Record<string, string> = {}, query: Record<string, unknown> = {}) => {
    const route = table.find(item => item.method === method && item.path === path)!;
    const request: ModuleRequest = { body, params, query, headers: {}, signal };
    return route.handler(request);
  };
}
test('direct clarification GET/POST preserves exact message/card identity, duplicate request receipt and stale failures', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.status = 'running';
    const request = client(f);
    const input = f.service.accept({ requestId: 'original', text: 'Raw original' }).message;
    const q = f.service.clarify({ messageId: input.id, question: 'Where?', choices: ['A','B'], allowFreeform: false }).clarification;
    const path = '/messages/:messageId/clarifications/:clarificationId', params = { messageId: input.id, clarificationId: q.id };
    const get = await request('GET', path, undefined, params);
    assert.deepEqual(get.body, { messageId: input.id, clarification: q });
    const answer = { requestId: 'stable-answer', answer: 'A' };
    const post = await request('POST', path, answer, params);
    assert.equal((post.body as { clarification: { requestId: string } }).clarification.requestId, answer.requestId);
    assert.deepEqual((await request('POST', path, answer, params)).body, post.body);
    assert.equal((await request('POST', path, { ...answer, answer: 'B' }, params)).status, 409);
    assert.equal((await request('POST', path, { requestId: 'later', answer: 'B' }, params)).status, 409);
    assert.equal((await request('GET', path, undefined, { ...params, clarificationId: 'wrong-card' })).status, 404);
    assert.equal(f.db.must('messages', input.id).raw, 'Raw original');
    assert.equal(f.db.must('messages', input.id).processed, false);
    assert.equal(f.db.find('messages', () => true).length, 1);
  } finally { await f.runtime.settled(); f.close(); }
});
test('messages and inputs keep owner-draft input receipt; no business work/delivery/operation tables or endpoints', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.status = 'running';
    const request = client(f);
    const value = { requestId: 'owner', text: 'Raw', attachments: [] };
    const response = await request('POST', '/messages', value);
    assert.deepEqual((response.body as { input: unknown }).input, value);
    const receipt = await request('GET', '/inputs/:requestId', undefined, { requestId: 'owner' });
    assert.deepEqual((receipt.body as { input: unknown }).input, value);
    assert.ok('topicMessages' in (receipt.body as object));
    assert.equal('work' in (receipt.body as object), false);
    assert.equal('deliveries' in (receipt.body as object), false);
    const paths = routes(f.service, f.runtime).map(route => route.path);
    for (const retired of ['/memories','/deliveries','/sessions/:id/history/recover']) assert.equal(paths.includes(retired), false);
    assert.equal((await request('GET', '/operations/:id', undefined, { id: 'lost-on-restart' })).status, 404);
  } finally { await f.runtime.settled(); f.close(); }
});
test('MCP lists only semantic coordinator tools; complete is one atomic original result without work proofs', async () => {
  const f = fixture();
  try {
    const request = client(f);
    const list = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (list.body as { result: { tools: { name: string }[] } }).result.tools.map(tool => tool.name);
    assert.deepEqual(names, ['assistant_topics','assistant_sessions','assistant_history','assistant_source','assistant_complete','assistant_clarify']);
    topic(f);
    const m = f.service.accept({ requestId: 'semantic', text: 'Raw' }).message;
    await f.runtime.wake();
    const identity = toolIdentity(f, m.id);
    const rpc = { jsonrpc: '2.0', id: 'complete', method: 'tools/call', params: { name: 'assistant_complete',
      arguments: { messageId: m.id, items: [{ topicId: 'topic', prompt: 'Faithful split' }] },
      _meta: { 'cockpit/invocation': identity } } };
    const response = await request('POST', '/mcp', rpc);
    assert.equal((response.body as { result: { isError: boolean } }).result.isError, false);
    assert.equal(f.db.must('messages', m.id).processed, true);
    const old = await request('POST', '/mcp', { ...rpc, params: { ...rpc.params, name: 'assistant_memory_claim' } });
    assert.equal((old.body as { result: { isError: boolean } }).result.isError, true);
  } finally { await f.runtime.settled(); f.close(); }
});
test('history tool passively reads a bounded ordinary page without ingesting or rewriting it', async () => {
  const f = fixture();
  try {
    const request = client(f);
    const m = f.service.accept({ requestId: 'history-reader', text: 'Related source' }).message;
    await f.runtime.wake();
    f.history.set('s1', [{ id: 'old-reply', type: 'assistant.message', data: { content: 'Old history' } },
      { id: 'old-subagent', agentId: 'agent', type: 'assistant.message', data: { content: 'Excluded' } }]);
    const response = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'assistant_history', arguments: { sessionId: 's1' },
        _meta: { 'cockpit/invocation': toolIdentity(f, m.id) } } });
    const body = response.body as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(body.result.isError, false);
    const history = JSON.parse(body.result.content[0]!.text) as { events: { content: string }[] };
    assert.deepEqual(history.events.map(event => event.content), ['Old history']);
    assert.equal(f.db.find('messages', () => true).length, 1);
    const call = f.calls.find(call => call.name === 'session/chat' && (call.body as { sessionId: string }).sessionId === 's1')!;
    assert.equal((call.body as { max: number }).max, 16);
    assert.equal((call.body as { source: string }).source, 'persisted');
  } finally { await f.runtime.settled(); f.close(); }
});
test('MCP protocol validation rejects legacy mutation fields and unsupported revisions', async () => {
  const f = fixture();
  try {
    const request = client(f);
    const invalid = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    assert.equal((invalid.body as { error: { code: number } }).error.code, -32602);
    const initialization = await request('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal((initialization.body as { result: { serverInfo: { version: string } } }).result.serverInfo.version, '3');
    assert.equal((await request('POST', '/roles/bind', { requestId: 'bind', role: 'memory', sessionId: 's1' })).status, 400);
    assert.equal((await request('POST', '/roles/bind', { requestId: 'bind', role: 'coordinator', sessionId: 'coordinator', expectedEpoch: 1 })).status, 400);
  } finally { await f.runtime.settled(); f.close(); }
});
test('semantic source-read can inspect one relevant previous original without granting mutation of it', async () => {
  const f = fixture();
  try {
    topic(f);
    const old = f.service.accept({ requestId: 'old-original', text: 'Old original body' }).message;
    f.service.complete({ messageId: old.id, items: [{ topicId: 'topic', prompt: 'Old split' }] });
    const current = f.service.accept({ requestId: 'current-original', text: 'Current original body' }).message;
    await f.runtime.wake();
    const request = client(f);
    const response = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'assistant_source', arguments: { messageId: old.id },
        _meta: { 'cockpit/invocation': toolIdentity(f, current.id) } } });
    const body = response.body as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(body.result.isError, false);
    assert.equal(JSON.parse(body.result.content[0]!.text).raw, 'Old original body');
    assert.equal(f.db.must('messages', current.id).processed, false);
    assert.equal(f.db.topicMessages(old.id).length, 1);
  } finally { await f.runtime.settled(); f.close(); }
});
test('one-session history exposes its actual current ask and saved topic associations without backfilling business sources', async () => {
  const f = fixture();
  try {
    const current = f.service.accept({ requestId: 'current', text: 'Current source' }).message;
    await f.runtime.wake();
    const ask = { requestId: 'passive-existing', question: 'Current native choice?', choices: ['Literal'], allowFreeform: false };
    f.metas.get('s1')!.ask = ask;
    const request = client(f);
    const response = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'assistant_history', arguments: { sessionId: 's1' },
        _meta: { 'cockpit/invocation': toolIdentity(f, current.id) } } });
    const body = response.body as { result: { content: { text: string }[] } };
    const history = JSON.parse(body.result.content[0]!.text);
    assert.deepEqual(history.currentAsk, ask);
    assert.deepEqual(history.currentAskTopicIds, []);
    assert.equal(f.db.find('messages', () => true).length, 1);
  } finally { await f.runtime.settled(); f.close(); }
});

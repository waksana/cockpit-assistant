import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModuleRequest } from '@waksana/cockpit-module-sdk/backend';
import { fixture, topic, toolIdentity } from './fixtures.ts';
import { routes } from '../src/http.ts';
import { fingerprint } from '../src/database.ts';

function request(body?: unknown, params: Record<string, string> = {}, query: Record<string, unknown> = {}): ModuleRequest {
  return { params, query, body, headers: {}, signal: new AbortController().signal };
}
test('state explicitly versions new semantics, retains old receipts and offers read-only legacy history', async () => {
  const f = fixture();
  try {
    const api = routes(f.service, f.runtime), call = async (method: string, path: string, req = request()) =>
      api.find(route => route.method === method && route.path === path)!.handler(req);
    const state = (await call('GET', '/state')).body as Record<string, unknown>;
    assert.equal(state.protocolVersion, 4); assert.equal(state.schemaVersion, 4);
    assert.equal(state.timelineProtocol, 'foreground-message-snapshots-v1');
    assert.equal(state.legacyTimelinePath, '/legacy/timeline');
    assert.equal(state.foregroundSessionId, 'coordinator');
    f.service.addMessage({ kind: 'reply', raw: 'Old historical reply', attachments: [], sessionId: 's1', nativeEventId: 'old' });
    assert.equal(((await call('GET', '/timeline')).body as { items: unknown[] }).items.length, 0);
    assert.equal(((await call('GET', '/legacy/timeline')).body as { items: unknown[] }).items.length, 1);
    assert.equal(api.some(r => r.method === 'POST' && r.path.includes('clarifications')), false);
    const body = { requestId: 'input', text: 'Exact HTTP human' };
    const posted = (await call('POST', '/messages', request(body))).body as { message: { id: string } };
    const inspected = (await call('GET', '/inputs/:requestId', request(undefined, { requestId: 'input' }))).body as { message: { id: string } };
    assert.equal(posted.message.id, inspected.message.id);
  } finally { await f.runtime.settled(); f.close(); }
});
test('MCP exports natural ledger/dispatch/inbox tools and no arbitrary peer send, complete or clarify', async () => {
  const f = fixture();
  try {
    const route = routes(f.service, f.runtime).find(r => r.path === '/mcp')!;
    const response = await route.handler(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const names = (response.body as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name);
    assert.deepEqual(names, ['assistant_topics', 'assistant_topic', 'assistant_dispatch', 'assistant_status', 'assistant_inbox',
      'assistant_sessions', 'assistant_history', 'assistant_source']);
    for (const name of ['assistant_complete', 'assistant_clarify', 'cockpit_send_prompt', 'respondAsk']) assert.equal(names.includes(name), false);
  } finally { f.close(); }
});
test('MCP invocation uses actual Host metadata and retired tools cannot reanimate legacy actions', async () => {
  const f = fixture();
  try {
    topic(f);
    const input = await f.runtime.acceptReady({ requestId: 'human', text: 'Business input' });
    const route = routes(f.service, f.runtime).find(r => r.path === '/mcp')!;
    const identity = toolIdentity(f, input.message.id);
    const call = async (name: string, args: unknown, meta = identity) => {
      const response = await route.handler(request({ jsonrpc: '2.0', id: 'rpc', method: 'tools/call',
        params: { name, arguments: args, _meta: { 'cockpit/invocation': meta } } }));
      return (response.body as { result: { isError: boolean; content: { text: string }[] } }).result;
    };
    assert.equal((await call('assistant_topics', {})).isError, false);
    assert.equal((await call('assistant_complete', { messageId: input.message.id, items: [] })).isError, true);
    assert.equal((await call('assistant_dispatch', { items: [{ topicId: 'topic', prompt: 'Faithful business input' }] })).isError, false);
    assert.equal(f.calls.filter(c => c.name === 'prompt').length, 2);
    assert.equal((await call('assistant_sessions', {})).isError, true);
  } finally { await f.runtime.settled(); f.close(); }
});
test('legacy input receipt recovery is passive and old pending sends never enter the current dispatch queue', async () => {
  const f = fixture();
  try {
    topic(f);
    const input = { requestId: 'old-input', text: '  Legacy original\n', attachments: [] };
    const message = f.service.addMessage({ kind: 'user', raw: input.text, attachments: [],
      input: { ...input, fingerprint: fingerprint(input) } });
    f.db.put('topic_messages', { id: 'legacy-send', messageId: message.id, topicId: 'topic',
      origin: 'user', prompt: 'Never replay', sessionId: 's1', state: 'pending', mode: null,
      requestId: null, wasFreeform: null, nativeMessageId: null, result: null, error: null, createdAt: 1 });
    const route = routes(f.service, f.runtime).find(r => r.path === '/inputs/:requestId')!;
    const revision = f.db.must('messages', message.id).revision;
    const response = await route.handler(request(undefined, { requestId: 'old-input' }));
    assert.deepEqual((response.body as { input: unknown }).input, input);
    await f.runtime.start();
    assert.equal(f.db.must('messages', message.id).revision, revision);
    assert.equal(f.db.must('messages', message.id).processed, false);
    assert.equal(f.db.must('topic_messages', 'legacy-send').state, 'pending');
    assert.equal(f.db.records('foreground_inputs').length, 0);
    assert.equal(f.calls.some(c => ['prompt', 'respondAsk', 'session/new'].includes(c.name)), false);
  } finally { f.close(); }
});
test('assistant_inbox presentation wire declares exact IDs/text without a new tool, bubble, or immediate consumption', async () => {
  const f = fixture();
  try {
    topic(f);
    await f.event('s1', { id: 'wire-result', type: 'assistant.message', data: { content: 'Wire body' } });
    const notice = f.db.records('foreground_inputs').find(root => root.kind === 'notification')!;
    const route = routes(f.service, f.runtime).find(r => r.path === '/mcp')!;
    const call = async (arguments_: unknown, callId: string) => {
      const identity = toolIdentity(f, '', callId, notice.receipt!);
      const response = await route.handler(request({ jsonrpc: '2.0', id: callId, method: 'tools/call',
        params: { name: 'assistant_inbox', arguments: arguments_, _meta: { 'cockpit/invocation': identity } } }));
      return (response.body as { result: { isError: boolean; content: { text: string }[] } }).result;
    };
    assert.equal((await call({ ids: notice.inboxIds }, 'wire-read')).isError, false);
    const text = 'The worker reported Wire body.';
    const declared = await call({ presentation: { ids: notice.inboxIds, text } }, 'wire-declare');
    assert.equal(declared.isError, false);
    const receipt = JSON.parse(declared.content[0]!.text);
    assert.equal(receipt.declared, true); assert.deepEqual(receipt.ids, notice.inboxIds);
    assert.equal(receipt.normalization, 'crlf-to-lf-outer-trim-v1');
    assert.equal(receipt.textHash.length, 64); assert.equal(receipt.afterSequence, 0);
    assert.equal(receipt.text, undefined);
    assert.equal(f.db.record('inbox', notice.inboxIds[0]!)!.body, 'Wire body');
    assert.equal(f.db.messagePage('before', undefined, 50).items.length, 0);
    assert.equal((await call({ ids: notice.inboxIds, presentation: { ids: notice.inboxIds, text } }, 'wire-mixed-read-claim')).isError, true);
    await f.event('coordinator', { id: 'wire-final', type: 'assistant.message',
      data: { messageId: 'wire-final', interactionId: receipt.interactionId, content: text } });
    assert.equal(f.db.record('inbox', notice.inboxIds[0]!)!.body, null);
  } finally { await f.runtime.settled(); f.close(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, topic, stageDelivery } from './fixtures.ts';
import { fingerprint } from '../src/database.ts';
import { questionIdentity } from '../src/question.ts';
test('ordinary or skill-labelled unmanaged sessions are never automatically collected', async () => {
  const f = fixture();
  try {
    for (const sessionId of ['s1', 's2', 'coordinator']) await f.event(sessionId,
      { id: `unmanaged-${sessionId}`, type: 'assistant.message', data: { content: 'No automatic collection' } });
    assert.equal(f.db.records('inbox').length, 0);
    assert.equal(f.db.list('messages').items.length, 0);
    assert.equal(f.calls.some(c => c.name === 'session/chat'), false);
  } finally { f.close(); }
});
test('only real registered worker final replies enter inbox, not ephemeral, tool, child, user or control text', async () => {
  const f = fixture();
  try {
    topic(f);
    for (const event of [
      { id: 'ephemeral', type: 'assistant.message', ephemeral: true, data: { content: 'stream' } },
      { id: 'tool', type: 'assistant.message', data: { content: 'work', toolRequests: [{ toolCallId: 'call' }] } },
      { id: 'child', type: 'assistant.message', agentId: 'subagent', data: { content: 'child' } },
      { id: 'peer-user', type: 'user.message', data: { content: 'peer' } },
      { id: 'idle', type: 'assistant.turn_end', data: { content: 'success' } },
    ]) await f.runtime.observe('s1', event);
    assert.equal(f.db.records('inbox').length, 0);
    await f.runtime.observe('s1', { id: 'real', type: 'assistant.message', data: { messageId: 'native', content: 'Exact body' } });
    const saved = f.db.records('inbox')[0]!;
    assert.equal(saved.body, 'Exact body'); assert.deepEqual(saved.topicIds, []);
    assert.deepEqual(saved.candidateTopicIds, ['topic']); assert.equal(saved.attribution, 'unknown');
    assert.equal(f.db.list('messages').items.length, 0);
    await assert.rejects(f.runtime.observe('s1', { id: 'duplicate', type: 'assistant.message',
      data: { messageId: 'native', content: 'Changed body' } }), { code: 'NATIVE_ID_CONFLICT' });
  } finally { f.close(); }
});
test('worker ask hash retains exact question and choice order while normalizing missing defaults', async () => {
  const f = fixture();
  try {
    topic(f); const request = { requestId: 'ask', question: '  Literal?\n' };
    f.metas.get('s1')!.ask = request; await f.runtime.observe('s1');
    f.metas.get('s1')!.ask = { ...request, choices: [], allowFreeform: true }; await f.runtime.observe('s1');
    assert.equal(f.db.records('inbox').length, 1);
    assert.equal(f.db.records('inbox')[0]!.hash, fingerprint(questionIdentity(request)));
    f.metas.get('s1')!.ask = { ...request, choices: ['A'] };
    await assert.rejects(f.runtime.observe('s1'), { code: 'NATIVE_ID_CONFLICT' });
    f.metas.get('s1')!.ask = null; await f.runtime.observe('s1');
    assert.equal(f.db.records('inbox')[0]!.askState, 'stale');
  } finally { f.close(); }
});
test('result dispatch locations are native-receipt-correlated, never guessed from all historical sends', async () => {
  const f = fixture();
  try {
    topic(f);
    const input = stageDelivery(f); await f.runtime.wake();
    const row = f.db.topicMessages(input.message.id)[0]!;
    await f.event('s1', { id: 'worker-user', type: 'user.message',
      data: { messageId: row.nativeMessageId, interactionId: 'worker-interaction' } });
    await f.event('s1', { id: 'result-linked', type: 'assistant.message',
      data: { messageId: 'result-linked', interactionId: 'worker-interaction', content: 'Linked result' } });
    await f.event('s1', { id: 'result-unproven', type: 'assistant.message', data: { content: 'Other native result' } });
    assert.deepEqual(f.db.records('inbox').find(i => i.nativeId === 'result-linked')!.dispatchIds, [row.id]);
    assert.deepEqual(f.db.records('inbox').find(i => i.nativeId === 'result-unproven')!.dispatchIds, []);
  } finally { f.close(); }
});
test('late native ask callbacks cannot resurrect a previous request against current Host state', async () => {
  const f = fixture();
  try {
    topic(f);
    f.metas.get('s1')!.ask = { requestId: 'current', question: 'Current question' };
    await f.runtime.observe('s1', undefined, { requestId: 'previous', question: 'Old callback' });
    assert.equal(f.db.records('inbox').length, 1);
    assert.equal(f.db.records('inbox')[0]!.nativeId, 'current');
  } finally { f.close(); }
});
test('shared session mappings are candidates only; proven interaction links identify only their actual dispatch topic', async () => {
  const f = fixture();
  try {
    topic(f, 'first', 's1'); topic(f, 'second', 's1');
    const input = stageDelivery(f, 'first-only', ['first']); await f.runtime.wake();
    const row = f.db.topicMessages(input.message.id)[0]!;
    await f.event('s1', { id: 'unattributed-shared', type: 'assistant.message',
      data: { content: 'No attributable dispatch identity' } });
    const unknown = f.db.records('inbox').find(item => item.nativeId === 'unattributed-shared')!;
    assert.deepEqual(unknown.topicIds, []);
    assert.deepEqual(unknown.candidateTopicIds, ['first', 'second']);
    assert.equal(unknown.attribution, 'unknown');
    await f.event('s1', { id: 'first-root', type: 'user.message',
      data: { messageId: row.nativeMessageId, interactionId: 'first-only-interaction' } });
    await f.event('s1', { id: 'first-result', type: 'assistant.message',
      data: { interactionId: 'first-only-interaction', content: 'Actual first-topic result' } });
    const linked = f.db.records('inbox').find(item => item.nativeId === 'first-result')!;
    assert.deepEqual(linked.topicIds, ['first']);
    assert.deepEqual(linked.candidateTopicIds, ['first', 'second']);
    assert.equal(linked.attribution, 'native-dispatch');
    assert.deepEqual(linked.dispatchIds, [row.id]);
    const notice = f.db.records('foreground_inputs').find(root => root.kind === 'notification')!;
    assert.equal(notice.text!.includes('candidateTopicNames'), true);
    assert.equal(notice.text!.includes('No attributable dispatch identity'), false);
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
  } finally { f.close(); }
});

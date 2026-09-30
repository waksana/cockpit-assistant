import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, topic, stageDelivery } from './fixtures.ts';

test('only new live complete primary replies ingest; startup never backfills history or existing asks', async () => {
  const f = fixture();
  try {
    f.history.set('s1', [{ id: 'offline', type: 'assistant.message', data: { content: 'Offline historical body' } }]);
    f.metas.get('s1')!.ask = { requestId: 'offline-question', question: 'Offline question' };
    await f.runtime.start();
    assert.equal(f.db.find('messages', () => true).length, 0);
    assert.equal(f.calls.some(call => call.name === 'session/chat'), false);
    f.metas.get('coordinator')!.status = 'running';
    await f.event('s1', { id: 'live-envelope', type: 'assistant.message', data: { messageId: 'live-body', content: 'Verbatim live\nreply' } });
    const saved = f.db.nativeMessage('s1', 'live-body')!;
    assert.equal(saved.raw, 'Verbatim live\nreply');
    assert.equal(saved.nativeEventId, 'live-envelope');
    assert.equal(saved.kind, 'reply');
    assert.equal(f.db.find('messages', () => true).length, 1);
  } finally { f.close(); }
});
test('repeated native identity deduplicates with a unique SQL constraint, never body rewrite', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.status = 'running';
    const event = { id: 'envelope1', type: 'assistant.message', data: { messageId: 'actual-id', content: 'Original native' } };
    await f.event('s1', event);
    const m = f.db.nativeMessage('s1', 'actual-id')!, revision = m.revision;
    await f.event('s1', { ...event, id: 'envelope2' });
    assert.equal(f.db.find('messages', () => true).length, 1);
    assert.equal(f.db.must('messages', m.id).revision, revision);
    assert.throws(() => f.db.put('messages', { ...m, id: 'duplicate', sequence: m.sequence + 1 }), /UNIQUE/);
    await f.event('s1', { ...event, data: { ...event.data, content: 'Changed body' } });
    assert.equal(f.db.must('messages', m.id).raw, 'Original native');
    assert.ok(f.errors.some(error => (error as Error).message.includes('immutable body')));
  } finally { f.close(); }
});
test('ordinary native user roots, ephemeral output, pure tool payload, internal role prose and subagents are not business messages', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.status = 'running';
    for (const event of [
      { id: 'user', type: 'user.message', data: { content: 'Direct native user' } },
      { id: 'partial', type: 'assistant.message', ephemeral: true, data: { content: 'Streaming partial' } },
      { id: 'agent', type: 'assistant.message', agentId: 'subagent', data: { content: 'Subagent reply' } },
      { id: 'parent-tool', type: 'assistant.message', parentToolCallId: 'parent', data: { content: 'Nested activity' } },
      { id: 'data-agent', type: 'assistant.message', data: { agentId: 'subagent', content: 'Nested reply' } },
      { id: 'tool', type: 'assistant.message', data: { toolRequests: [{ toolCallId: 'tool', arguments: { text: 'Not reply content' } }] } },
    ]) await f.event('s1', event);
    await f.event('coordinator', { id: 'role-prose', type: 'assistant.message', data: { content: 'Internal role explanation' } });
    f.metas.get('s2')!.roles = [{ moduleId: 'assistant', roleId: 'memory', moduleName: 'Assistant', name: 'retired memory' }];
    await f.event('s2', { id: 'old-memory', type: 'assistant.message', data: { content: 'Old memory role body' } });
    assert.equal(f.db.find('messages', () => true).length, 0);
  } finally { f.close(); }
});
test('complete primary content with ask_user tool requests remains an immutable deduplicated original, without tool payload', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.status = 'running';
    const event = { id: 'a2c6eaa3-b0b5-4a57-b1a0-f8462f72b548', type: 'assistant.message',
      data: { messageId: '2988ff2d-a4fd-48de-aa85-88422993b9df',
        content: 'ALPHA first segment before native ask.',
        attachments: [{ type: 'file', path: '/synthetic/alpha-output' }],
        toolRequests: [{ toolCallId: 'ask-tool', name: 'ask_user',
          arguments: { question: 'Tool payload is not an original', choices: ['blue','green'] } }] } };
    await f.event('s1', event);
    const message = f.db.nativeMessage('s1', event.data.messageId)!;
    assert.equal(message.raw, event.data.content);
    assert.deepEqual(message.attachments, event.data.attachments);
    assert.equal(message.nativeEventId, event.id);
    assert.equal(message.processed, false);
    assert.equal('toolRequests' in message, false);
    assert.equal(JSON.stringify(message).includes('Tool payload is not an original'), false);
    await f.event('s1', { ...event, id: 'repeat-envelope' });
    assert.equal(f.db.find('messages', () => true).length, 1);
    assert.equal(f.db.must('messages', message.id).revision, message.revision);
    await f.event('coordinator', { ...event, id: 'internal-mixed' });
    await f.event('s1', { ...event, id: 'subagent-mixed', agentId: 'child' });
    assert.equal(f.db.find('messages', () => true).length, 1);
  } finally { f.close(); }
});
test('complete primary attachment-only output is retained even when it also carries tool requests', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.status = 'running';
    const attachments = [{ type: 'file', path: '/synthetic/attachment-only' }];
    await f.event('s1', { id: 'attachment-tool-envelope', type: 'assistant.message',
      data: { messageId: 'attachment-tool-native', attachments, toolRequests: [{ toolCallId: 'attached-tool' }] } });
    const message = f.db.nativeMessage('s1', 'attachment-tool-native')!;
    assert.equal(message.raw, '');
    assert.deepEqual(message.attachments, attachments);
    assert.equal('toolRequests' in message, false);
  } finally { f.close(); }
});
test('new native ask is a chronological immutable original, deduplicated by its request identity and revisioned when stale', async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    f.metas.get('coordinator')!.status = 'running';
    f.metas.get('s1')!.ask = { requestId: 'new-question', question: 'Exact question?', choices: ['Yes','No'], allowFreeform: false };
    await f.runtime.wake('s1');
    const first = f.db.nativeQuestion('s1', 'new-question')!;
    assert.equal(first.raw, 'Exact question?');
    assert.equal(first.kind, 'ask'); assert.equal(first.processed, false);
    assert.equal(first.nativeMessageId, null, 'Native request identity must not be invented as a message receipt');
    assert.equal(f.db.sql.prepare('SELECT question_request_id FROM messages WHERE id=?').get(first.id)!.question_request_id, 'new-question');
    await f.runtime.wake('s1');
    assert.equal(f.db.find('messages', () => true).length, 1);
    f.metas.get('s1')!.ask = { requestId: 'next-question', question: 'Next?' };
    await f.runtime.wake('s1');
    assert.equal(f.db.must('messages', first.id).question!.state, 'stale');
    assert.ok(f.db.must('messages', first.id).revision > first.revision);
    const next = f.db.nativeQuestion('s1', 'next-question')!;
    assert.ok(next.sequence > first.sequence);
    assert.throws(() => f.db.put('messages', { ...next,
      question: { ...next.question!, request: { ...next.question!.request, choices: ['Changed'] } } }), /cannot change/);
  } finally { f.close(); }
});
test('exact current native ask on the mapped topic uses respondAsk with literal choice identity', async () => {
  const f = fixture();
  try {
    topic(f);
    const ask = { requestId: 'real-request', question: 'Choose?', choices: ['Exact A','Exact B'], allowFreeform: false };
    f.metas.get('s1')!.ask = ask;
    const q = f.service.question('s1', ask)!;
    f.service.complete({ messageId: q.id, items: [{ topicId: 'topic' }] });
    const input = f.service.accept({ requestId: 'answer', text: 'Exact B' }).message;
    f.service.complete({ messageId: input.id, items: [{ topicId: 'topic', prompt: 'Exact B' }] });
    await f.runtime.wake();
    assert.deepEqual(f.calls.find(call => call.name === 'respondAsk')!.body,
      { sessionId: 's1', requestId: 'real-request', answer: 'Exact B', wasFreeform: false });
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    const send = f.db.topicMessages(input.id)[0]!;
    assert.equal(send.mode, 'ask'); assert.equal(send.state, 'accepted'); assert.equal(send.requestId, 'real-request');
    assert.equal(f.db.must('messages', q.id).question!.state, 'answered');
  } finally { f.close(); }
});
for (const constraint of ['choice','attachment'] as const) test(`native ask ${constraint} failure is rejected visibly, never faked with prompt`, async () => {
  const f = fixture();
  try {
    topic(f);
    const ask = { requestId: 'choices', question: 'Literal?', choices: ['Literal'], allowFreeform: false };
    f.metas.get('s1')!.ask = ask;
    const q = f.service.question('s1', ask)!;
    f.service.complete({ messageId: q.id, items: [{ topicId: 'topic' }] });
    const input = f.service.accept({ requestId: 'answer', text: constraint === 'choice' ? 'Paraphrased' : 'Literal',
      attachments: constraint === 'attachment' ? [{ type: 'file', path: '/synthetic/file' }] : [] }).message;
    f.service.complete({ messageId: input.id, items: [{ topicId: 'topic', prompt: input.raw }] });
    await f.runtime.wake();
    assert.equal(f.db.topicMessages(input.id)[0]!.state, 'rejected');
    assert.equal(f.calls.some(call => call.name === 'respondAsk' || call.name === 'prompt'), false);
    assert.ok(f.errors.length > 0);
  } finally { f.close(); }
});
test('freeform native ask uses wasFreeform=true and a different topic ask is not historical arbitration', async () => {
  const f = fixture();
  try {
    topic(f, 'a', 's1'); topic(f, 'b', 's1');
    const ask = { requestId: 'freeform', question: 'Details?', choices: ['Offered'], allowFreeform: true };
    f.metas.get('s1')!.ask = ask;
    const q = f.service.question('s1', ask)!;
    f.service.complete({ messageId: q.id, items: [{ topicId: 'a' }] });
    const b = stageDelivery(f, 'b-input', ['b']);
    await f.runtime.wake();
    assert.equal(f.db.topicMessages(b.message.id)[0]!.mode, 'prompt');
    const a = stageDelivery(f, 'a-input', ['a']);
    await f.runtime.wake();
    assert.equal(f.db.topicMessages(a.message.id)[0]!.mode, 'ask');
    assert.equal((f.calls.find(call => call.name === 'respondAsk')!.body as { wasFreeform: boolean }).wasFreeform, true);
  } finally { f.close(); }
});
test('handoff never answers an old unmapped question; current target receives a prompt', async () => {
  const f = fixture();
  try {
    topic(f, 'topic', 's2');
    const ask = { requestId: 'old', question: 'Old session question?' };
    f.metas.get('s1')!.ask = ask;
    const q = f.service.question('s1', ask)!;
    f.service.complete({ messageId: q.id, items: [{ topicId: 'topic' }] });
    stageDelivery(f);
    await f.runtime.wake();
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
    assert.equal((f.calls.find(call => call.name === 'prompt')!.body as { sessionId: string }).sessionId, 's2');
    assert.equal(f.db.must('messages', q.id).question!.state, 'pending');
  } finally { f.close(); }
});
test('actual live question observations are retained even if the callback disappears before metadata sampling', async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    f.metas.get('coordinator')!.status = 'running';
    const actual = { requestId: 'quick-question', question: 'Short-lived exact question?', choices: ['A','B'] };
    f.runtime.noteQuestion('s1', actual);
    f.metas.get('s1')!.ask = null;
    await f.runtime.wake('s1');
    const source = f.db.nativeQuestion('s1', 'quick-question')!;
    assert.equal(source.raw, actual.question);
    assert.deepEqual(source.question!.request.choices, actual.choices);
    assert.equal(source.question!.state, 'stale');
    assert.equal(source.processed, false);
  } finally { f.close(); }
});
test('interleaved live replies and native questions keep observation order across ordinary sessions', async () => {
  const f = fixture();
  try {
    f.metas.get('coordinator')!.status = 'running';
    f.runtime.noteEvent('s1', { id: 'a', type: 'assistant.message', data: { content: 'First' } });
    f.runtime.noteQuestion('s2', { requestId: 'b', question: 'Second?' });
    f.runtime.noteEvent('s1', { id: 'c', type: 'assistant.message', data: { content: 'Third' } });
    await f.runtime.wake();
    assert.deepEqual(f.db.find('messages', () => true).map(m => m.raw), ['First','Second?','Third']);
  } finally { f.close(); }
});
for (const outcome of ['rejected','unknown'] as const) test(`native ask ${outcome} uses truthful diagnostics without prompt fallback or repeated answer`, async () => {
  const f = fixture();
  try {
    topic(f);
    const ask = { requestId: 'ask-outcome', question: 'Question?' };
    f.metas.get('s1')!.ask = ask;
    const q = f.service.question('s1', ask)!;
    f.service.complete({ messageId: q.id, items: [{ topicId: 'topic' }] });
    const staged = stageDelivery(f);
    if (outcome === 'rejected') f.answerResult(false);
    else f.fail('respondAsk', new Error('Answer acceptance connection lost'));
    await f.runtime.wake(); await f.runtime.wake();
    const row = f.db.topicMessages(staged.message.id)[0]!;
    assert.equal(row.state, outcome);
    assert.equal(f.calls.filter(call => call.name === 'respondAsk').length, 1);
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    assert.equal(f.db.must('messages', q.id).question!.state, outcome === 'unknown' ? 'unknown' : 'pending');
    assert.ok(f.errors.some(error => (error as { topicMessageId?: string }).topicMessageId === row.id));
  } finally { f.close(); }
});
test('authoritative current ask can remain pending after an unknown answer, without retrying that uncertain send', async () => {
  const f = fixture();
  try {
    topic(f);
    const ask = { requestId: 'still-current', question: 'Question?' };
    f.metas.get('s1')!.ask = ask;
    const q = f.service.question('s1', ask)!;
    f.service.complete({ messageId: q.id, items: [{ topicId: 'topic' }] });
    const first = stageDelivery(f, 'first');
    f.fail('respondAsk', new Error('Lost answer acknowledgement'));
    await f.runtime.wake();
    assert.equal(f.db.topicMessages(first.message.id)[0]!.state, 'unknown');
    f.fail('respondAsk', null);
    await f.runtime.wake('s1');
    assert.equal(f.db.must('messages', q.id).question!.state, 'pending');
    assert.equal(f.db.topicMessages(first.message.id)[0]!.state, 'unknown');
    assert.equal(f.calls.filter(call => call.name === 'respondAsk').length, 1);
    const next = stageDelivery(f, 'new-explicit-answer');
    await f.runtime.wake();
    assert.equal(f.db.topicMessages(next.message.id)[0]!.mode, 'ask');
    assert.equal(f.calls.filter(call => call.name === 'respondAsk').length, 2);
  } finally { f.close(); }
});
test('missing role fields use actual public Host evidence, never assume an internal carrier is ordinary', async () => {
  const f = fixture();
  try {
    const meta = f.metas.get('s1')!;
    delete meta.roles; delete meta.appliedRoles;
    f.roleEvidence.set('s1', [{ moduleId: 'assistant', roleId: 'memory', moduleName: 'Assistant', name: 'retired carrier' }]);
    await f.event('s1', { id: 'internal-evidence', type: 'assistant.message', data: { content: 'Must not become business' } });
    assert.equal(f.db.find('messages', () => true).length, 0);
    assert.ok(f.calls.some(call => call.name === 'roles/readiness' && (call.body as { sessionId: string }).sessionId === 's1'));
    assert.equal((await f.runtime.readiness()).canSend, true, 'Retired memory never becomes a readiness requirement');
  } finally { f.close(); }
});
test('unconfirmed role metadata is reported rather than persisting guessed business input', async () => {
  const f = fixture();
  try {
    const meta = f.metas.get('s1')!;
    delete meta.roles; delete meta.appliedRoles;
    f.fail('roles/readiness', new Error('Current native role evidence unavailable'));
    await f.event('s1', { id: 'unconfirmed-source', type: 'assistant.message', data: { content: 'Unconfirmed origin' } });
    assert.equal(f.db.find('messages', () => true).length, 0);
    assert.ok(f.errors.some(error => (error as Error).message.includes('role evidence unavailable')));
  } finally { f.close(); }
});
test('native ask body and literal answer preserve whitespace through parsing, storage and actual public response payload', async () => {
  const f = fixture();
  try {
    topic(f);
    const literal = ' \tApprove exactly\n  ';
    const ask = { requestId: 'exact-native-choice', question: '  Native question wording\n ',
      choices: [literal], allowFreeform: false };
    f.metas.get('s1')!.ask = ask;
    const source = f.service.question('s1', ask)!;
    f.service.complete({ messageId: source.id, items: [{ topicId: 'topic' }] });
    const user = f.service.accept({ requestId: 'exact-native-answer', text: literal }).message;
    f.service.complete({ messageId: user.id, items: [{ topicId: 'topic', prompt: literal }] });
    await f.runtime.wake();
    const payload = f.calls.find(call => call.name === 'respondAsk')!.body as { answer: string; wasFreeform: boolean };
    assert.equal(payload.answer, literal);
    assert.equal(payload.wasFreeform, false);
    assert.equal(f.db.must('messages', source.id).raw, ask.question);
    assert.equal(f.service.receipt(f.db.must('messages', user.id)).input.text, literal);
  } finally { f.close(); }
});

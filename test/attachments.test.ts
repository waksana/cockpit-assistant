import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModuleRequest, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { attachmentsSchema, inputSchema, MAX_ATTACHMENT_BYTES } from '../src/attachments.ts';
import type { NativeAttachment } from '../src/attachments.ts';
import { Database, fingerprint } from '../src/database.ts';
import { AssistantService, questionKey } from '../src/service.ts';
import { routes } from '../src/http.ts';
import { inputReceipt, timeline } from '../src/ui.ts';
import { fixture, stageDelivery, topic } from './fixtures.ts';

const attachments: NativeAttachment[] = [
  { type: 'file', path: '/synthetic/input.txt', displayName: 'Input' },
  { type: 'directory', path: '/synthetic/source' },
  { type: 'selection', filePath: '/synthetic/code.ts', displayName: 'Selection', text: 'hello',
    selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } },
  { type: 'blob', data: 'aGk=', mimeType: 'text/plain', displayName: 'Inline' },
];
const input = (requestId = 'attached') => ({ requestId, text: '', attachments: structuredClone(attachments) });
function batch(f: ReturnType<typeof fixture>) {
  return f.service.startBatch(f.db.must('bindings', 'coordinator'))!;
}
function route(f: ReturnType<typeof fixture>, sessionIds = ['s1']) {
  for (const sessionId of sessionIds) topic(f, `attachments:${sessionId}`, sessionId);
  batch(f);
  f.service.dispatch(f.identities.coordinator, {
    items: sessionIds.map(sessionId => ({ topicId: `attachments:${sessionId}`, prompt: `Read attachments for ${sessionId}` })),
  });
  return f.db.find('deliveries', delivery => delivery.kind !== 'wake');
}
function ask(f: ReturnType<typeof fixture>) {
  const request = { requestId: 'q', question: 'Proceed?', choices: ['Yes', 'No'], allowFreeform: false };
  f.db.transaction(() => f.service.syncQuestions('s1', [request], true));
  f.metas.get('s1')!.ask = request;
  const question = f.db.must('questions', questionKey('s1', 'q'));
  topic(f, 'answer');
  const current = batch(f);
  f.service.attribute(f.identities.coordinator, { items: [{ messageId: question.messageId, topicId: 'answer' }] });
  f.service.finishBatch(current.id, 'finished');
  return question;
}
function api(f: ReturnType<typeof fixture>) {
  f.runtime.wake = async () => {};
  const handlers = routes(f.service, f.runtime);
  return (method: ModuleRoute['method'], path: string, extra: Partial<ModuleRequest> = {}) => {
    const handler = handlers.find(item => item.method === method && item.path === path)!;
    return handler.handler({ params: {}, query: {}, headers: {}, body: undefined,
      signal: new AbortController().signal, ...extra });
  };
}

test('shared input schema strictly validates all SDK shapes, counts, ranges and byte limits', () => {
  assert.deepEqual(inputSchema.parse(input()), input());
  assert.deepEqual(inputSchema.parse({ requestId: 'plain', text: 'hello' }).attachments, []);
  assert.equal(attachmentsSchema.parse(Array.from({ length: 20 }, () => attachments[0]!)).length, 20);
  for (const value of [
    { requestId: 'empty', text: '' },
    { ...input(), unexpected: true },
    { ...input(), attachments: null },
    { ...input(), attachments: Array.from({ length: 21 }, () => attachments[0]) },
    ...[
      { type: 'file', path: '/a', url: 'https://preview.invalid/a' },
      { type: 'file', path: 'https://preview.invalid/a' },
      { type: 'file', path: 'relative.txt' },
      { type: 'directory', path: '/bad\0path' },
      { type: 'blob', data: 'data:text/plain;base64,aGk=', mimeType: 'text/plain' },
      { type: 'blob', data: '%%%=', mimeType: 'text/plain' },
      { type: 'blob', data: 'aGk=', mimeType: 'not-a-mime' },
      { type: 'blob', mimeType: 'text/plain', omittedReason: 'not supplied' },
      { type: 'selection', filePath: '/a', displayName: 'a', text: 'x'.repeat(100_001) },
      { ...attachments[2], selection: { start: { line: 1, character: 2 }, end: { line: 0, character: 0 } } },
      { ...attachments[2], selection: { start: { line: 0, character: -1 }, end: { line: 0, character: 0 } } },
      { ...attachments[2], selection: { start: { line: 0, character: 0, extra: true }, end: { line: 1, character: 0 } } },
    ].map(item => ({ ...input(), attachments: [item] })),
  ]) assert.equal(inputSchema.safeParse(value).success, false, JSON.stringify(value).slice(0, 180));
  assert.equal(attachmentsSchema.safeParse([
    { type: 'blob', data: 'A'.repeat(MAX_ATTACHMENT_BYTES), mimeType: 'image/png' },
  ]).success, false);
  assert.equal(attachmentsSchema.safeParse(Array.from({ length: 4 }, () => ({
    type: 'selection', filePath: '/a', displayName: 'a', text: '字'.repeat(100_000),
  }))).success, false, 'byte count, not UTF-16 character count');
});

test('attachment fingerprints are stable and change on any attachment descriptor difference', () => {
  const f = fixture();
  try {
    const value = input();
    const accepted = f.service.accept(value);
    value.attachments[0] = { type: 'file', path: '/mutated-client' };
    assert.deepEqual(f.db.must('messages', accepted.message.id).attachments, attachments);
    assert.deepEqual(f.service.accept(input()), accepted);
    for (const changed of [
      attachments.slice().reverse(),
      [{ ...attachments[0], displayName: 'Changed' }, ...attachments.slice(1)],
      [{ type: 'file', path: '/changed' }],
    ]) assert.throws(() => f.service.accept({ ...input(), attachments: changed }), /different input/);
    assert.throws(() => f.service.accept({ ...input(), attachments: [{ type: 'blob', data: 'eA==', mimeType: 'text/plain' }] }),
      /different input/);
    const plain = f.service.accept({ requestId: 'plain', text: 'hello' });
    assert.deepEqual(f.service.accept({ requestId: 'plain', text: 'hello', attachments: [] }), plain);
    f.service.accept({ ...input('with-text'), text: 'hello' });
    assert.throws(() => f.service.accept({ requestId: 'with-text', text: 'hello' }), /different input/);
  } finally { f.close(); }
});

test('pure attachment acceptance needs no existing reception and does not fake text', async () => {
  const f = fixture();
  try {
    for (const reception of f.db.list('receptions').items) f.db.put('receptions', { ...reception, enabled: false });
    f.metas.delete('s1'); f.metas.delete('s2');
    const accepted = await f.runtime.acceptReady(input());
    assert.equal(accepted.message.raw, '');
    assert.deepEqual(accepted.message.attachments, attachments);
    assert.deepEqual(accepted.work.attachments, attachments);
    assert.equal(f.db.list('deliveries').items.length, 0);
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    assert.deepEqual(inputReceipt(f.service, 'attached').input, input());
  } finally { f.close(); }
});

test('delivery and publication snapshots remain immutable while timeline projects corrected content', async () => {
  const f = fixture();
  try {
    const accepted = f.service.accept(input());
    const [delivery] = route(f);
    const topicId = delivery!.topicId!;
    f.db.transaction(() => f.service.memory.schedule(topicId));
    assert.deepEqual(f.db.find('work', work => work.role === 'memory')[0]!.attachments, []);
    f.service.correct(accepted.message.id, 'Corrected later', 1, 'Correct source',
      [{ type: 'file', path: '/new-version' }]);
    const first = f.db.meta<{ attachments: NativeAttachment[] }>(`revision:${accepted.message.id}:1`, { attachments: [] });
    assert.deepEqual(first.attachments, attachments);
    assert.deepEqual(f.db.must('work', accepted.work.id).attachments, attachments);
    assert.deepEqual(f.db.must('deliveries', delivery!.id).attachments, attachments);
    const publication = timeline(f.service, undefined, undefined, 100).items.find(item => item.type === 'message')!;
    assert.equal(publication.text, 'Corrected later');
    assert.deepEqual(publication.attachments, [{ type: 'file', path: '/new-version' }]);
    const originalPublication = f.db.must('publications', publication.id);
    assert.equal(originalPublication.text, '');
    assert.deepEqual(originalPublication.attachments, attachments);
    const receipt = inputReceipt(f.service, 'attached');
    assert.equal(receipt.message.version, 1);
    assert.equal(receipt.message.raw, '');
    assert.deepEqual(receipt.input, input());
    assert.deepEqual(f.service.accept(input()), accepted);
    await f.runtime.wake();
    const sent = f.calls.filter(call => call.name === 'prompt'
      && (call.body as { sessionId: string }).sessionId === 's1');
    assert.deepEqual(sent.map(call => call.body), [
      { sessionId: 's1', mode: 'enqueue', text: 'Read attachments for s1', attachments },
    ]);
    for (const wake of f.calls.filter(call => call.name === 'prompt'
      && ['coordinator', 'memory'].includes((call.body as { sessionId: string }).sessionId))) {
      assert.equal('attachments' in (wake.body as object), false);
    }
    assert.equal(inputReceipt(f.service, 'attached').deliveries[0]!.state, 'accepted');
  } finally { f.close(); }
});

test('ordinary attachment input remains accepted when a native question cannot consume it', () => {
  const f = fixture();
  try {
    const question = ask(f);
    assert.throws(() => f.service.accept({ ...input(), replyTo: question.messageId }), /Unrecognized key/);
    const accepted = f.service.accept({ ...input(), text: 'Yes' });
    batch(f);
    assert.throws(() => f.service.dispatch(f.identities.coordinator, {
      items: [{ topicId: 'answer', prompt: 'Yes' }],
    }), /cannot accept attachments/);
    assert.equal(f.db.list('deliveries').items.length, 0);
    assert.equal(f.db.must('work', accepted.work.id).state, 'leased');
    assert.deepEqual(inputReceipt(f.service, 'attached').input.attachments, attachments);
    f.service.clarify(f.identities.coordinator, { text: 'Answer this native question without attachments in its original session.' });
    assert.equal(f.db.must('work', accepted.work.id).state, 'done');
    assert.equal(f.db.must('questions', question.id).state, 'pending');
  } finally { f.close(); }
});

test('native send rechecks ask attachment and choice restrictions against frozen delivery', async () => {
  for (const change of [
    { attachments },
    { text: 'Sure', answerFreeform: true },
    { answerFreeform: true },
  ]) {
    const f = fixture();
    try {
      ask(f);
      f.service.accept({ requestId: 'answer', text: 'Yes' });
      batch(f);
      f.service.dispatch(f.identities.coordinator, { items: [{ topicId: 'answer', prompt: 'Yes' }] });
      const delivery = f.db.find('deliveries', item => item.kind === 'ask')[0]!;
      f.db.put('deliveries', { ...delivery!, ...change });
      await f.runtime.wake();
      const result = f.db.must('deliveries', delivery!.id);
      assert.equal(result.state, 'rejected');
      assert.match(result.error!, /attachments|exactly match|answer mode/);
      assert.equal(f.calls.some(call => call.name === 'answer'), false);
      assert.equal(f.calls.some(call => call.name === 'prompt'
        && (call.body as { sessionId: string }).sessionId === 's1'), false);
      assert.equal(f.db.must('operations', 'input:answer').state, 'accepted');
    } finally { f.close(); }
  }
});

test('a late pending ask rolls back the whole multi-topic dispatch and keeps original attachments', () => {
  const f = fixture();
  try {
    topic(f, 'available', 's2'); topic(f, 'blocked', 's1');
    const accepted = f.service.accept(input());
    batch(f);
    f.service.syncQuestions('s1', [{ requestId: 'late', question: 'Which?', choices: ['A'] }], true);
    const snapshot = () => ({
      tables: Object.fromEntries((['messages', 'topics', 'publications', 'deliveries', 'messageTopics',
        'batches', 'work', 'memories', 'operations', 'questions'] as const)
        .map(table => [table, f.db.find(table, () => true)])),
      metadata: f.db.sql.prepare('SELECT key,value FROM meta ORDER BY key').all(),
    });
    const before = snapshot();
    assert.throws(() => f.service.dispatch(f.identities.coordinator, {
      items: [{ topicId: 'available', prompt: 'Read file' }, { topicId: 'blocked', prompt: 'Explain file' }],
    }), /unclassified or ambiguous native question/);
    assert.deepEqual(snapshot(), before, 'failed routing must roll back classification, publication and completion');
    assert.equal(f.db.must('work', accepted.work.id).state, 'leased');
    f.service.clarify(f.identities.coordinator, {
      text: 'This session is waiting for a native answer and cannot accept these attachments as an answer.',
    });
    assert.equal(f.db.must('work', accepted.work.id).state, 'done');
    assert.equal(f.db.list('deliveries').items.length, 0);
    assert.deepEqual(f.db.list('publications').items.map(item => item.type), ['message', 'question', 'clarification']);
    assert.deepEqual(inputReceipt(f.service, 'attached').input.attachments, attachments);
  } finally { f.close(); }
});

test('multi-target partial acceptance never resends or bypasses an ask that appears before send', async () => {
  const f = fixture();
  try {
    f.service.accept(input());
    const deliveries = route(f, ['s1', 's2']);
    assert.deepEqual(deliveries.map(delivery => delivery.attachments), [attachments, attachments]);
    assert.deepEqual(deliveries.map(delivery => delivery.topicId), ['attachments:s1', 'attachments:s2']);
    f.onPrompt(async () => {
      f.metas.get('s2')!.ask = { requestId: 'late', question: 'Which?', choices: ['A'], allowFreeform: false };
    });
    await f.runtime.wake();
    assert.deepEqual(deliveries.map(delivery => f.db.must('deliveries', delivery.id).state), ['accepted', 'rejected']);
    f.onPrompt(null);
    f.metas.get('s2')!.ask = null;
    await f.runtime.wake();
    f.service.recover();
    await f.runtime.wake();
    const sent = f.calls.filter(call => call.name === 'prompt'
      && ['s1', 's2'].includes((call.body as { sessionId: string }).sessionId));
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0]!.body as { attachments: NativeAttachment[] }).attachments, attachments);
    const receipt = inputReceipt(f.service, 'attached');
    assert.deepEqual(receipt.input, input());
    assert.equal(f.db.must('operations', 'input:attached').state, 'accepted');
  } finally { f.close(); }
});

test('multi-topic dispatch forwards the complete original attachments once to every mapped session', async () => {
  const f = fixture();
  try {
    const accepted = f.service.accept(input());
    const deliveries = route(f, ['s1', 's2']);
    await f.runtime.wake();
    await f.runtime.wake();
    const sent = f.calls.filter(call => call.name === 'prompt'
      && ['s1', 's2'].includes((call.body as { sessionId: string }).sessionId));
    assert.deepEqual(sent.map(call => call.body), ['s1', 's2'].map(sessionId => ({
      sessionId, mode: 'enqueue', text: `Read attachments for ${sessionId}`, attachments,
    })));
    assert.deepEqual(deliveries.map(delivery => f.db.must('deliveries', delivery.id).state), ['accepted', 'accepted']);
    assert.equal(f.db.find('publications', publication => publication.type === 'message'
      && publication.messageId === accepted.message.id).length, 1);
    assert.deepEqual(inputReceipt(f.service, 'attached').input, input());
    assert.equal(f.db.must('messages', accepted.message.id).raw, '');
  } finally { f.close(); }
});

test('database restart preserves captured attachments and unknown delivery independently of input acceptance', () => {
  const path = resolve(`.attachments-${randomUUID()}.sqlite`);
  let db = new Database(path);
  try {
    const service = new AssistantService(db);
    const accepted = service.accept(input());
    db.put('deliveries', { id: 'effect', kind: 'prompt', messageId: accepted.message.id,
      sessionId: 'not-yet-existing', requestId: null, text: '', attachments: accepted.message.attachments,
      supplement: null, answerFreeform: null, state: 'calling', result: null, error: null, createdAt: 1, roleEpoch: null });
    db.close();
    db = new Database(path);
    const restored = new AssistantService(db);
    restored.recover();
    const receipt = inputReceipt(restored, 'attached');
    assert.deepEqual(receipt.input, input());
    assert.deepEqual(receipt.work[0]!.attachments, attachments);
    assert.deepEqual(receipt.deliveries[0]!.attachments, attachments);
    assert.equal(receipt.deliveries[0]!.state, 'unknown');
    assert.equal(db.must('operations', 'input:attached').state, 'accepted');
    assert.deepEqual(restored.accept(input()), accepted);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

test('stored attachment descriptors are validated rather than silently normalized', () => {
  const f = fixture();
  try {
    const accepted = f.service.accept(input());
    f.db.sql.prepare('UPDATE messages SET document=json_set(document, ?, json(?)) WHERE id=?')
      .run('$.attachments', JSON.stringify([{ type: 'file', path: '/a', unknown: true }]), accepted.message.id);
    assert.throws(() => f.db.must('messages', accepted.message.id));
    assert.throws(() => f.db.list('messages'));
  } finally { f.close(); }
});

test('HTTP acceptance, receipt and semantic batch expose captured attachments', async () => {
  const f = fixture();
  try {
    const request = api(f);
    const accepted = await request('POST', '/messages', { body: input() });
    assert.equal(accepted.status, undefined);
    const current = batch(f);
    const batchText = f.service.batchText(current);
    assert.match(batchText, /synthetic\/input.txt/);
    assert.match(batchText, /"type":"blob","mimeType":"text\/plain","displayName":"Inline","bytes":4/);
    assert.equal(batchText.includes('aGk='), false, 'coordinator receives descriptors, not inline blob payloads');
    const message = f.db.list('messages').items[0]!;
    f.service.correct(message.id, 'Corrected', 1, 'Source correction', []);
    const revision = f.db.meta<{ attachments: NativeAttachment[] } | null>(`revision:${message.id}:1`, null);
    assert.deepEqual(revision?.attachments, attachments);
    const receipt = await request('GET', '/inputs/:requestId', { params: { requestId: 'attached' } });
    assert.equal(receipt.status, undefined);
    assert.deepEqual((receipt.body as { input: unknown }).input, input());
    assert.equal((await request('POST', '/messages', { body: { ...input(), attachments: [{ type: 'file', path: 'https://preview' }] } })).status, 400);
  } finally { f.close(); }
});

test('ingestion preserves attachments and treats changed native attachments as a new immutable revision', () => {
  const f = fixture();
  try {
    stageDelivery(f, { state: 'accepted', nativeMessageId: 'assistant-prompt',
      interactionId: 'assistant-interaction', interactionState: 'active',
      result: { ok: true, messageId: 'assistant-prompt' } });
    const events = (suffix: string, value: NativeAttachment[]) => [
      { id: 'assistant-prompt-event', type: 'user.message', parentId: null,
        data: { content: 'Relevant split prompt', messageId: 'assistant-prompt', interactionId: 'assistant-interaction' } },
      { id: `start${suffix}`, type: 'assistant.turn_start',
        data: { turnId: '0' }, parentId: 'assistant-prompt-event' },
      { id: `message${suffix}`, type: 'assistant.message', parentId: `start${suffix}`,
        data: { content: '', messageId: 'native-message', toolRequests: [], attachments: value,
          interactionId: 'assistant-interaction' } },
      { id: `end${suffix}`, type: 'assistant.turn_end',
        data: { turnId: '0' }, parentId: `message${suffix}` },
    ];
    f.runtime.ingestion.apply('s1', 1, events('1', attachments), 'cursor1');
    const message = f.db.find('messages', item => item.kind === 'reply')[0]!;
    assert.deepEqual(message.attachments, attachments);
    const originalEvidence = f.db.must('native', fingerprint(['s1', 'message1']));
    assert.deepEqual(originalEvidence.event.data, {
      messageId: 'native-message', interactionId: 'assistant-interaction',
      contentFingerprint: fingerprint(['', attachments]),
    });
    f.runtime.ingestion.apply('s1', 1, events('2', [attachments[0]!]), 'cursor2');
    assert.equal(f.db.must('messages', message.id).version, 2);
    assert.deepEqual(f.db.meta<{ attachments: NativeAttachment[] }>(`revision:${message.id}:1`, { attachments: [] }).attachments,
      attachments);
    assert.deepEqual(f.db.must('work', `message:${message.id}:2`).attachments, [attachments[0]]);
    assert.throws(() => f.runtime.ingestion.apply('s1', 1, events('1', []), 'bad'), /changed its durable payload/);
    assert.equal(f.db.must('receptions', 's1').cursor, 'cursor2');
    assert.deepEqual(f.db.must('native', fingerprint(['s1', 'message1'])), originalEvidence);
    const descriptors = [{ type: 'blob', mimeType: 'image/png', omittedReason: 'too_large' }];
    f.runtime.ingestion.apply('s1', 1, [
      { id: 'native-user', type: 'user.message', data: { content: '', attachments: descriptors } },
    ], 'cursor3');
    assert.equal(f.db.get('native', fingerprint(['s1', 'native-user'])), undefined);
    assert.equal(f.db.find('messages', item => item.kind === 'reply').length, 1);
  } finally { f.close(); }
});

test('related native content and attachments cannot change under the same event identity', () => {
  const f = fixture();
  try {
    stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
    const root = { id: 'root-event', type: 'user.message',
      data: { messageId: 'receipt', interactionId: 'interaction', content: 'Forwarded prompt' } };
    const event = { id: 'reply-event', type: 'assistant.message',
      data: { messageId: 'reply', interactionId: 'interaction', content: 'Original', attachments } };
    const id = fingerprint(['s1', event.id]);
    f.runtime.ingestion.apply('s1', 1, [root, event], 'retained');
    const evidence = f.db.must('native', id);
    assert.deepEqual(evidence.event.data, {
      messageId: 'reply', interactionId: 'interaction', contentFingerprint: fingerprint(['Original', attachments]),
    });
    f.runtime.ingestion.apply('s1', 1, [event], 'replayed');
    for (const changed of [
      { ...event.data, attachments: [] },
      { ...event.data, content: 'Changed' },
    ]) {
      assert.throws(() => f.runtime.ingestion.apply('s1', 1,
        [{ ...event, data: changed }], 'changed'), /changed its durable payload/);
    }
    assert.equal(f.db.must('receptions', 's1').cursor, 'replayed');
    assert.deepEqual(f.db.must('native', id), evidence);
    const message = f.db.find('messages', item => item.kind === 'reply')[0]!;
    assert.equal(message.raw, 'Original');
    assert.deepEqual(message.attachments, attachments);
    assert.equal(message.version, 1);
  } finally { f.close(); }
});

test('ordinary reply attachments are retained once while native user attachments are not input', () => {
  const f = fixture();
  try {
    stageDelivery(f, { state: 'accepted', nativeMessageId: 'assistant-receipt' });
    for (const value of [attachments, attachments]) {
      f.runtime.ingestion.apply('s1', 1, [
        { id: 'ordinary-user', type: 'user.message', data: {
          messageId: 'ordinary-receipt', interactionId: 'ordinary-interaction', content: 'Private Chat input', attachments: value,
        } },
        { id: 'ordinary-reply', type: 'assistant.message', data: {
          messageId: 'ordinary-reply', interactionId: 'ordinary-interaction', content: 'Private Chat reply', attachments: value,
        } },
      ], 'ignored');
    }
    assert.equal(f.db.list('native').items.length, 1);
    assert.equal(f.db.list('messageTopics').items.length, 0);
    const replies = f.db.find('messages', message => message.kind === 'reply');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0]!.attachments, attachments);
    assert.equal(f.db.find('messages', message => message.raw === 'Private Chat input').length, 0);
    assert.equal(f.db.find('work', work => work.kind === 'output').length, 1);
    assert.equal(f.db.must('receptions', 's1').cursor, 'ignored');
  } finally { f.close(); }
});

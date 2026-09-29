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
import type { Work } from '../src/types.ts';
import { fixture, proof } from './fixtures.ts';

const attachments: NativeAttachment[] = [
  { type: 'file', path: '/synthetic/input.txt', displayName: 'Input' },
  { type: 'directory', path: '/synthetic/source' },
  { type: 'selection', filePath: '/synthetic/code.ts', displayName: 'Selection', text: 'hello',
    selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } },
  { type: 'blob', data: 'aGk=', mimeType: 'text/plain', displayName: 'Inline' },
];
const input = (requestId = 'attached') => ({ requestId, text: '', attachments: structuredClone(attachments) });
function route(f: ReturnType<typeof fixture>, work: Work, sessionIds = ['s1'], answerQuestionId?: string) {
  const claimed = f.service.claim(f.identities.coordinator, 'coordinator', 1, work.id)!;
  f.service.decide(f.identities.coordinator, { ...proof(claimed),
    topic: { title: 'Attachments', independent: true }, reason: 'Explicit input',
    action: { kind: 'route', sessionIds, routeVersion: 0, ...(answerQuestionId ? { answerQuestionId } : {}) } });
  return f.db.find('deliveries', delivery => delivery.messageId === work.messageId);
}
function ask(f: ReturnType<typeof fixture>) {
  const request = { requestId: 'q', question: 'Proceed?', choices: ['Yes', 'No'], allowFreeform: false };
  f.db.transaction(() => f.service.syncQuestions('s1', [request], true));
  f.metas.get('s1')!.ask = request;
  const question = f.db.must('questions', questionKey('s1', 'q'));
  f.db.put('anchors', { id: question.messageId, messageId: question.messageId, sessionId: 's1',
    requestId: 'q', kind: 'ask' });
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
    const [delivery] = route(f, accepted.work);
    const topicId = f.db.must('messages', accepted.message.id).topicId!;
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
      { sessionId: 's1', mode: 'enqueue', text: '', attachments },
    ]);
    for (const wake of f.calls.filter(call => call.name === 'prompt'
      && ['coordinator', 'memory'].includes((call.body as { sessionId: string }).sessionId))) {
      assert.equal('attachments' in (wake.body as object), false);
    }
    assert.equal(inputReceipt(f.service, 'attached').deliveries[0]!.state, 'accepted');
  } finally { f.close(); }
});

test('ordinary input accepts attachments and free text; actual ask routes enforce their restrictions', () => {
  const f = fixture();
  try {
    const question = ask(f);
    assert.throws(() => f.service.accept({ ...input(), replyTo: question.messageId }), /Unrecognized key/);
    const badChoice = f.service.accept({ requestId: 'bad-choice', text: 'Sure' });
    assert.throws(() => route(f, badChoice.work, ['s1'], question.id), /exactly match/);
    const unanchored = f.service.accept({ ...input(), text: 'Yes' });
    const claimed = f.service.claim(f.identities.coordinator, 'coordinator', 1, unanchored.work.id)!;
    assert.throws(() => f.service.decide(f.identities.coordinator, { ...proof(claimed),
      topic: { title: 'Answer', independent: true }, reason: 'Literal answer',
      action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0, answerQuestionId: question.id } }),
    /cannot accept attachments/);
    assert.equal(f.db.list('deliveries').items.length, 0);
    const valid = f.service.accept({ requestId: 'text-answer', text: 'Yes' });
    f.service.correct(valid.message.id, 'Yes', 1, 'Added attachments', attachments);
    assert.throws(() => route(f, f.db.must('work', `message:${valid.message.id}:2`), ['s1'], question.id), /cannot accept attachments/);
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
      const question = ask(f);
      const accepted = f.service.accept({ requestId: 'answer', text: 'Yes' });
      const [delivery] = route(f, accepted.work, ['s1'], question.id);
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

test('a late pending ask blocks ordinary routing only to its session and keeps work available', () => {
  const f = fixture();
  try {
    const original = f.service.addMessage({ kind: 'reply', raw: 'Earlier comment', sessionId: 's1' });
    f.db.put('anchors', { id: original.id, messageId: original.id, sessionId: 's1',
      requestId: null, kind: 'comment' });
    const accepted = f.service.accept(input());
    ask(f);
    const claimed = f.service.claim(f.identities.coordinator, 'coordinator', 1, accepted.work.id)!;
    const snapshot = () => ({
      tables: Object.fromEntries((['messages', 'topics', 'publications', 'deliveries', 'routes', 'exposures',
        'risks', 'work', 'memories', 'operations', 'questions'] as const)
        .map(table => [table, f.db.find(table, () => true)])),
      metadata: f.db.sql.prepare('SELECT key,value FROM meta ORDER BY key').all(),
    });
    const before = snapshot();
    assert.throws(() => f.service.decide(f.identities.coordinator, {
      ...proof(claimed, 'blocked-comment-route'), topic: { title: 'New topic', independent: true },
      reason: 'Reply to earlier comment', action: { kind: 'route', sessionIds: ['s1'], routeVersion: 0 },
    }), /pending native question/);
    assert.deepEqual(snapshot(), before, 'failed routing must roll back classification, publication and completion');
    assert.equal(f.db.must('work', accepted.work.id).state, 'leased');
    assert.equal(f.db.get('operations', 'decision:blocked-comment-route'), undefined);
    const reclaimed = f.service.claim(f.identities.coordinator, 'coordinator', 1, accepted.work.id)!;
    f.service.decide(f.identities.coordinator, {
      ...proof(reclaimed, 'clarify-comment'), topic: { title: 'Attachment reply', independent: true },
      reason: 'A native question appeared after input acceptance',
      action: { kind: 'clarify', text: 'This session is waiting for a native answer and cannot accept these attachments as an answer.' },
    });
    assert.equal(f.db.must('work', accepted.work.id).state, 'done');
    assert.equal(f.db.list('deliveries').items.length, 0);
    assert.deepEqual(f.db.list('publications').items.map(item => item.type), ['message', 'clarification']);
    assert.deepEqual(inputReceipt(f.service, 'attached').input.attachments, attachments);
  } finally { f.close(); }
});

test('multi-target partial acceptance never resends or bypasses an ask that appears before send', async () => {
  const f = fixture();
  try {
    const accepted = f.service.accept(input());
    const deliveries = route(f, accepted.work, ['s1', 's2']);
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

test('legacy text-only documents normalize only missing attachment fields including revision and receipt reads', async () => {
  const f = fixture();
  try {
    const request = api(f);
    const accepted = f.service.accept({ requestId: 'old', text: 'Original' });
    route(f, accepted.work);
    f.service.correct(accepted.message.id, 'Current', 1, 'Correction');
    for (const table of ['messages', 'work', 'deliveries', 'publications']) {
      f.db.sql.exec(`UPDATE ${table} SET document=json_remove(document, '$.attachments')`);
    }
    f.db.sql.exec(`UPDATE operations SET document=json_remove(document,
      '$.result.input', '$.result.message.attachments', '$.result.work.attachments') WHERE id='input:old'`);
    f.db.sql.prepare('UPDATE meta SET value=json_remove(value, ?) WHERE key=?')
      .run('$.attachments', `revision:${accepted.message.id}:1`);
    assert.deepEqual(f.db.must('messages', accepted.message.id).attachments, []);
    assert.deepEqual(inputReceipt(f.service, 'old').message.attachments, []);
    assert.deepEqual(f.service.accept({ requestId: 'old', text: 'Original', attachments: [] }).work.attachments, []);
    assert.deepEqual(timeline(f.service, undefined, undefined, 20).items[0]!.attachments, []);
    const revision = await request('GET', '/messages/:id/versions/:version',
      { params: { id: accepted.message.id, version: '1' } });
    assert.deepEqual((revision.body as { message: { attachments: NativeAttachment[] } }).message.attachments, []);
    f.db.sql.prepare('UPDATE messages SET document=json_set(document, ?, json(?)) WHERE id=?')
      .run('$.attachments', JSON.stringify([{ type: 'file', path: '/a', unknown: true }]), accepted.message.id);
    assert.throws(() => f.db.must('messages', accepted.message.id));
    assert.throws(() => f.db.list('messages'));
  } finally { f.close(); }
});

test('legacy input receipts preserve original topic and reply identity independently of classification', () => {
  const f = fixture();
  try {
    f.db.put('topics', { id: 'original-topic', title: 'Original', independent: true, domain: null,
      relatedTo: [], pinned: false, archived: false, version: 1, dirtyThrough: 0, memoryThrough: 0 });
    const parent = f.service.addMessage({ kind: 'reply', raw: 'Reply source', sessionId: 's1' });
    f.db.put('anchors', { id: parent.id, messageId: parent.id, sessionId: 's1', kind: 'comment', requestId: null });
    const captured = { ...input(), topicId: 'original-topic', replyTo: parent.id };
    const accepted = f.service.accept(input());
    const legacyMessage = { ...accepted.message, topicId: captured.topicId, replyTo: parent.id };
    f.db.put('messages', legacyMessage);
    f.db.put('operations', { ...f.db.must('operations', 'input:attached'), fingerprint: fingerprint(captured),
      result: { ...accepted, message: legacyMessage, input: captured } });
    const stored = f.db.must('operations', 'input:attached').result as { input: unknown };
    assert.deepEqual(stored.input, captured);
    route(f, accepted.work);
    assert.notEqual(f.db.must('messages', accepted.message.id).topicId, captured.topicId);
    f.service.correct(accepted.message.id, 'Different text', 1, 'Correction', []);
    assert.deepEqual(inputReceipt(f.service, 'attached').input, captured);
    assert.deepEqual((f.db.must('operations', 'input:attached').result as { input: unknown }).input, captured);
    assert.throws(() => f.service.accept(captured), /Unrecognized key/);
    assert.throws(() => f.service.accept({ ...input(), topicId: captured.topicId }), /different input/);
  } finally { f.close(); }
});

test('HTTP acceptance, receipt and coordinator work reads expose real attachment snapshots', async () => {
  const f = fixture();
  try {
    const request = api(f);
    const accepted = await request('POST', '/messages', { body: input() });
    assert.equal(accepted.status, undefined);
    const work = f.service.claim(f.identities.coordinator, 'coordinator', 1)!;
    const response = await request('POST', '/mcp', { body: {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'assistant_read', arguments: { role: 'coordinator', epoch: 1, resource: 'work', workId: work.id },
        _meta: { 'cockpit/invocation': f.identities.coordinator },
      },
    } });
    const result = (response.body as { result: { isError: boolean; content: { text: string }[] } }).result;
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0]!.text).items[0].attachments, attachments);
    const receipt = await request('GET', '/inputs/:requestId', { params: { requestId: 'attached' } });
    assert.equal(receipt.status, undefined);
    assert.deepEqual((receipt.body as { input: unknown }).input, input());
    assert.equal((await request('POST', '/messages', { body: { ...input(), attachments: [{ type: 'file', path: 'https://preview' }] } })).status, 400);
  } finally { f.close(); }
});

test('ingestion preserves attachments and treats changed native attachments as a new immutable revision', () => {
  const f = fixture();
  try {
    const events = (suffix: string, value: NativeAttachment[]) => [
      { id: `start${suffix}`, type: 'assistant.turn_start', data: {}, parentId: null },
      { id: `message${suffix}`, type: 'assistant.message', parentId: `start${suffix}`,
        data: { content: '', messageId: 'native-message', toolRequests: [], attachments: value } },
      { id: `end${suffix}`, type: 'assistant.turn_end', data: {}, parentId: `message${suffix}` },
    ];
    f.runtime.ingestion.apply('s1', 1, events('1', attachments), 'cursor1');
    const message = f.db.list('messages').items[0]!;
    assert.deepEqual(message.attachments, attachments);
    f.runtime.ingestion.apply('s1', 1, events('2', [attachments[0]!]), 'cursor2');
    assert.equal(f.db.must('messages', message.id).version, 2);
    assert.deepEqual(f.db.meta<{ attachments: NativeAttachment[] }>(`revision:${message.id}:1`, { attachments: [] }).attachments,
      attachments);
    assert.deepEqual(f.db.must('work', `message:${message.id}:2`).attachments, [attachments[0]]);
    assert.throws(() => f.runtime.ingestion.apply('s1', 1, events('1', []), 'bad'), /changed its durable payload/);
    assert.equal(f.db.must('receptions', 's1').cursor, 'cursor2');
    assert.deepEqual(f.db.must('native', fingerprint(['s1', 'message1'])).event.data.attachments, attachments);
    const descriptors = [{ type: 'blob', mimeType: 'image/png', omittedReason: 'too_large' }];
    f.runtime.ingestion.apply('s1', 1, [
      { id: 'native-user', type: 'user.message', data: { content: '', attachments: descriptors } },
    ], 'cursor3');
    assert.deepEqual(f.db.must('native', fingerprint(['s1', 'native-user'])).event.data.attachments, descriptors);
  } finally { f.close(); }
});

test('legacy native retention can regain omitted attachment facts once without accepting later payload mutation', () => {
  const f = fixture();
  try {
    const event = { id: 'legacy-native', type: 'user.message', data: { content: 'Original' } };
    const id = fingerprint(['s1', event.id]);
    f.db.put('native', { id, sessionId: 's1', event, historical: true });
    const restored = { ...event, data: { ...event.data, attachments } };
    f.runtime.ingestion.apply('s1', 1, [restored], 'restored');
    assert.deepEqual(f.db.must('native', id).event.data.attachments, attachments);
    assert.equal(f.db.must('native', id).attachmentRetentionVersion, 1);
    assert.throws(() => f.runtime.ingestion.apply('s1', 1,
      [{ ...restored, data: { ...restored.data, attachments: [] } }], 'changed'), /changed its durable payload/);
    f.runtime.ingestion.apply('s1', 1, [{ ...event, id: 'new-native' }], 'new');
    assert.throws(() => f.runtime.ingestion.apply('s1', 1,
      [{ ...restored, id: 'new-native' }], 'changed'), /changed its durable payload/);
  } finally { f.close(); }
});

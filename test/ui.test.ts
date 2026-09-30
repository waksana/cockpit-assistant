import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { ModuleRequest, ModuleRoute } from '@waksana/cockpit-module-sdk/backend';
import { routes } from '../src/http.ts';
import { ref } from '../src/service.ts';
import { timelineItem, timeline } from '../src/ui.ts';
import type { NativeAttachment } from '../src/attachments.ts';
import { Database } from '../src/database.ts';
import { AssistantService } from '../src/service.ts';
import { fixture, stageDelivery } from './fixtures.ts';
import type { InputReceipt, Readiness, TimelineItem, TimelinePage } from '../src/ui-types.ts';
import type { Topic } from '../src/types.ts';

function topic(db: Database, title: string): Topic {
  const value: Topic = { id: `topic-${title}`, title, content: title, color: '#2563eb',
    sessionId: 's1', archived: false, version: 1, dirtyThrough: 0, memoryThrough: 0 };
  db.put('topics', value);
  return value;
}

function setup() {
  const f = fixture();
  let wakes = 0;
  f.runtime.wake = async () => { wakes++; };
  const api = routes(f.service, f.runtime);
  const request = async (method: ModuleRoute['method'], path: string,
    extra: Partial<ModuleRequest> = {}) => {
    const route = api.find(item => item.method === method && item.path === path)!;
    return route.handler({ params: {}, query: {}, headers: {}, body: undefined,
      signal: new AbortController().signal, ...extra });
  };
  return { ...f, request, wakes: () => wakes };
}

test('accepted original input is immediately visible once with no topic, including exact replay', () => {
  const f = setup();
  try {
    const input = { requestId: 'two-topics', text: 'Check Hangzhou weather and review this code',
      attachments: [{ type: 'file' as const, path: '/synthetic/source.ts' }] };
    const accepted = f.service.accept(input);
    f.service.accept(input);
    const page = timeline(f.service, undefined, undefined, 100);
    const original = page.items.filter(item => item.messageId === accepted.message.id && item.type === 'message');
    assert.equal(original.length, 1);
    assert.equal(original[0]!.text, input.text);
    assert.deepEqual(original[0]!.attachments, input.attachments);
    assert.equal(original[0]!.speaker, 'user');
    assert.equal(original[0]!.topicId, null);
    assert.equal(original[0]!.topicTitle, null);
    assert.equal(original[0]!.topicColor, null);
    assert.equal(f.db.must('messages', accepted.message.id).topicId, null);
  } finally { f.close(); }
});

test('reply projection keeps topic color and original body, while user history has no topic label', () => {
  const f = setup();
  try {
    const assigned = topic(f.db, 'Weather');
    const reply = f.service.addMessage({ kind: 'reply', raw: 'The complete original reply', sessionId: 's1',
      topicId: assigned.id, attachments: [{ type: 'file', path: '/synthetic/forecast.txt' }] });
    const publication = f.service.publish({ type: 'message', messageId: reply.id, topicId: assigned.id,
      text: reply.raw, sources: [ref(reply)] });
    const projected = timelineItem(f.service, publication);
    assert.equal(projected.text, reply.raw);
    assert.deepEqual(projected.attachments, reply.attachments);
    assert.equal(projected.topicTitle, 'Weather');
    assert.equal(projected.topicColor, '#2563eb');
    f.db.put('topics', { ...assigned, title: 'Hangzhou weather' });
    assert.equal(timelineItem(f.service, publication).topicColor, projected.topicColor);
    assert.equal(timelineItem(f.service, publication).topicTitle, 'Hangzhou weather');
    const user = f.service.accept({ requestId: 'old-topic-label', text: 'An original multi-topic input' });
    const oldPublication = f.service.publish({ type: 'message', messageId: user.message.id,
      topicId: assigned.id, text: user.message.raw });
    assert.equal(timelineItem(f.service, oldPublication).topicId, null);
    assert.equal(timelineItem(f.service, oldPublication).topicTitle, null);
    assert.equal(timelineItem(f.service, oldPublication).topicColor, null);
  } finally { f.close(); }
});

test('readiness excludes disabled history before bounding the active reception window', async () => {
  const f = setup();
  try {
    const original = f.db.must('receptions', 's1');
    for (const reception of f.db.list('receptions').items) {
      f.db.put('receptions', { ...reception, enabled: false });
    }
    for (let index = 0; index < 110; index++) {
      f.db.put('receptions', { ...original, id: `old-${index}`, enabled: false });
    }
    f.db.put('receptions', { ...original, id: 'active-late' });
    f.metas.set('active-late', { ...f.metas.get('s1')!, sessionId: 'active-late' });
    const result = await f.runtime.readiness();
    assert.equal(result.canSend, true);
    assert.deepEqual(result.receptions.map(entry => entry.id), ['active-late']);
    assert.equal(result.receptions[0]?.availability, 'loaded');
    assert.equal(f.calls.some(call => JSON.stringify(call).includes('old-')), false);
  } finally { f.close(); }
});

test('timeline uses exclusive sequence windows and a global watermark, including sparse sequences', async () => {
  const f = setup();
  try {
    for (const sequence of [2, 4, 8, 20, 30]) f.service.publish({ sequence, type: 'status', text: String(sequence) });
    const get = async (query: Record<string, unknown>) =>
      (await f.request('GET', '/timeline', { query })).body as TimelinePage;
    const latest = await get({ limit: 2 });
    assert.deepEqual(latest.items.map(item => item.sequence), [20, 30]);
    assert.equal(latest.before, 20);
    assert.equal(latest.watermark, 30);
    assert.equal(latest.hasMore, true);
    const older = await get({ before: latest.before, limit: 2 });
    assert.deepEqual(older.items.map(item => item.sequence), [4, 8]);
    assert.equal(older.watermark, 30);
    assert.equal((await get({ before: 2 })).before, null);
    const forward = await get({ after: 4, limit: 2 });
    assert.deepEqual(forward.items.map(item => item.sequence), [8, 20]);
    assert.equal(forward.cursor, 20);
    assert.equal(forward.hasMore, true);
    assert.equal((await get({ after: 100 })).cursor, 100);
    for (const query of [{ before: 0, after: 0 }, { before: '-1' }, { after: '9007199254740993' },
      { limit: 101 }, { limit: 0 }, { arbitrary: true }]) {
      assert.equal((await f.request('GET', '/timeline', { query })).status, 400);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('timeline exact lookup and stream enrich questions without changing stored publications', async () => {
  const f = setup();
  const controller = new AbortController();
  try {
    f.service.syncQuestions('s1', [{ requestId: 'ask-1', question: 'Choose', choices: ['A', 'B'], allowFreeform: false }], true);
    const question = f.db.list('questions').items[0]!;
    const message = f.db.must('messages', question.messageId);
    const assigned = topic(f.db, 'Question topic');
    f.db.put('messages', { ...message, topicId: assigned.id, assignmentVersion: 1 });
    const publication = f.service.publish({ type: 'question', messageId: message.id, topicId: assigned.id,
      text: message.raw, attachments: message.attachments, sources: [ref(message)] });
    const exact = async () => (await f.request('GET', '/timeline/items/:sequence',
      { params: { sequence: String(publication.sequence) } })).body as TimelineItem;
    const item = await exact();
    assert.equal(item.topicTitle, 'Question topic');
    assert.equal(item.topicColor, '#2563eb');
    assert.equal(item.speaker, 'assistant');
    assert.equal(item.sessionId, 's1');
    assert.equal(item.text, 'Choose');
    assert.deepEqual(item.revision, { version: 1, text: 'Choose', attachments: [] });
    assert.deepEqual(item.question, { state: 'pending', stateVersion: 1, choices: ['A', 'B'], allowFreeform: false });
    question.state = 'answered';
    f.db.put('questions', question);
    assert.equal((await exact()).question?.state, 'answered');
    const response = await f.request('GET', '/timeline/stream', {
      query: { after: 0 }, headers: { 'last-event-id': String(publication.sequence - 1) }, signal: controller.signal,
    });
    assert.ok(response.body instanceof Readable);
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      const frame = String((await iterator.next()).value);
      assert.match(frame, new RegExp(`^id: ${publication.sequence}\\nevent: publication\\n`));
      assert.match(frame, /"topicTitle":"Question topic"/);
      assert.match(frame, /"state":"answered"/);
    } finally { controller.abort(); await iterator.return?.(); }
    const plain = f.db.list('publications');
    assert.ok(plain.items.every(entry => !('speaker' in entry)));
    assert.ok(plain.items.every(entry => !('revision' in entry)));
    assert.equal(plain.items[0]!.text, message.raw);
    assert.match(plain.items[0]!.text, /Choices: \["A","B"\]\nFree-text answers: not allowed/);
    const status = f.service.publish({ type: 'status', messageId: message.id, text: 'No topic at publication' });
    const oldStatus = (await f.request('GET', '/timeline/items/:sequence',
      { params: { sequence: String(status.sequence) } })).body as TimelineItem;
    assert.equal(oldStatus.topicId, null);
    assert.equal(oldStatus.topicTitle, null);
    assert.equal(oldStatus.text, status.text);
    assert.equal(oldStatus.speaker, 'system');
    assert.deepEqual(oldStatus.revision, { version: 1, text: 'Choose', attachments: [] });
    assert.equal((await f.request('GET', '/timeline/items/:sequence', { params: { sequence: '999' } })).status, 404);
    assert.equal(f.calls.length, 0);
  } finally { controller.abort(); f.close(); }
});

test('restored question state publishes a patch and outranks cached unknown snapshots', async () => {
  const f = setup();
  try {
    const ask = { requestId: 'restored-question', question: 'Which project?', choices: ['First', 'Second'], allowFreeform: true };
    f.service.syncQuestions('s1', [ask], true);
    const question = f.db.list('questions').items[0]!;
    const message = f.db.must('messages', question.messageId);
    const published = f.service.publish({ type: 'question', messageId: message.id,
      text: message.raw, sources: [ref(message)] });
    f.service.syncQuestions('s1', [], false);
    const status = f.db.find('publications', item => item.type === 'status')[0]!;
    const cached = (await f.request('GET', '/timeline/items/:sequence',
      { params: { sequence: String(status.sequence) } })).body as TimelineItem;
    assert.equal(cached.question!.state, 'unknown');
    assert.equal(cached.question!.stateVersion, 2);
    const before = f.db.list('publications').items;
    f.service.syncQuestions('s1', [ask], true);
    const publications = f.db.list('publications').items;
    assert.deepEqual(publications.slice(0, -1), before, 'restoration preserves existing publications');
    assert.equal(publications.at(-1)!.type, 'status');
    assert.equal(publications.at(-1)!.messageId, question.messageId);
    const stored = f.db.must('questions', question.id);
    assert.equal(stored.stateVersion, 3);
    const olderPage = (await f.request('GET', '/timeline',
      { query: { before: status.sequence, limit: 1 } })).body as TimelinePage;
    const fresh = olderPage.items[0]!;
    assert.equal(fresh.id, published.id);
    assert.ok(fresh.sequence < cached.sequence);
    assert.equal(fresh.question!.state, 'pending');
    assert.ok(fresh.question!.stateVersion > cached.question!.stateVersion);
    assert.deepEqual(f.db.must('questions', question.id), stored, 'projection reads never write state');
    assert.deepEqual(f.db.list('publications').items, publications);
    assert.equal(f.calls.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('question counters advance only on state changes and ignore stale or invented input counters', () => {
  const f = setup();
  try {
    const ask = { requestId: 'state-version', question: 'Proceed?', choices: ['Yes'] };
    f.service.syncQuestions('s1', [ask], true);
    const original = f.db.list('questions').items[0]!;
    assert.equal(original.stateVersion, 1);
    f.db.put('questions', { ...original, stateVersion: 999 });
    assert.equal(f.db.must('questions', original.id).stateVersion, 1);
    f.service.syncQuestions('s1', [ask], true);
    assert.equal(f.db.must('questions', original.id).stateVersion, 1);
    let version = 1;
    for (const state of ['unknown', 'pending', 'stale', 'answered', 'unknown'] as const) {
      f.db.put('questions', { ...original, state, stateVersion: 0 });
      assert.equal(f.db.must('questions', original.id).stateVersion, ++version);
      f.db.put('questions', { ...original, state, stateVersion: 500 });
      assert.equal(f.db.must('questions', original.id).stateVersion, version);
    }
    f.db.put('questions', { ...original, id: 'another-question', stateVersion: 999 });
    assert.equal(f.db.must('questions', 'another-question').stateVersion, 1);
    const before = f.db.must('questions', original.id);
    assert.throws(() => f.db.transaction(() => {
      f.db.put('questions', { ...original, state: 'pending' });
      throw new Error('Rollback state transition');
    }), /Rollback/);
    assert.deepEqual(f.db.must('questions', original.id), before);
  } finally { f.close(); }
});

test('question state counters survive database reopening and advance only on a new transition', () => {
  const path = `test/.question-state-${randomUUID()}.sqlite`;
  let db = new Database(path);
  try {
    const service = new AssistantService(db);
    const ask = { requestId: 'persisted-question', question: 'Original question?', choices: ['Continue'] };
    service.syncQuestions('persisted-session', [ask], true);
    const question = db.list('questions').items[0]!;
    const message = db.must('messages', question.messageId);
    const publication = service.publish({ type: 'question', messageId: message.id, text: message.raw,
      sources: [ref(message)] });
    db.close();
    db = new Database(path);
    const reopened = new AssistantService(db);
    const raw = () => db.sql.prepare('SELECT document FROM questions WHERE id=?').get(question.id)!.document;
    const original = raw();
    assert.equal(db.must('questions', question.id).stateVersion, 1);
    assert.equal(db.list('questions').items[0]!.stateVersion, 1);
    assert.equal(db.forMessage('questions', message.id).items[0]!.stateVersion, 1);
    assert.equal(timelineItem(reopened, publication).question!.stateVersion, 1);
    assert.equal(raw(), original);
    assert.equal(Number(db.sql.prepare('PRAGMA user_version').get()!.user_version), 2);
    db.put('questions', { ...question, stateVersion: 900 });
    assert.equal(db.must('questions', question.id).stateVersion, 1, 'saving the same state does not increment');
    reopened.syncQuestions('persisted-session', [], false);
    assert.equal(db.must('questions', question.id).stateVersion, 2);
    reopened.syncQuestions('persisted-session', [ask], true);
    assert.equal(db.must('questions', question.id).stateVersion, 3);
    db.close();
    db = new Database(path);
    assert.equal(db.must('questions', question.id).stateVersion, 3);
    assert.equal(db.must('publications', publication.id).text, message.raw);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

test('user corrections project current text and attachments without mutating publications, receipts or queue state', async () => {
  const f = setup();
  try {
    const originalAttachments: NativeAttachment[] = [{ type: 'file', path: '/synthetic/old.txt' }];
    const currentAttachments: NativeAttachment[] = [{ type: 'file', path: '/synthetic/new.txt' }];
    const input = f.service.accept({ requestId: 'corrected-user', text: 'Old wording', attachments: originalAttachments });
    const publication = f.service.publish({ type: 'message', messageId: input.message.id,
      text: input.message.raw, attachments: originalAttachments, sources: [ref(input.message)] });
    f.service.correct(input.message.id, 'Correct wording', 1, 'User corrected their message', currentAttachments);
    const correction = f.db.find('publications', item => item.type === 'correction')[0]!;
    const before = {
      publications: f.db.list('publications').items,
      work: f.db.list('work').items,
      operations: f.db.list('operations').items,
      messages: f.db.list('messages').items,
      version: f.service.version,
    };
    const recent = (await f.request('GET', '/timeline', { query: { limit: 1 } })).body as TimelinePage;
    assert.equal(recent.items[0]!.id, correction.id);
    assert.equal(recent.items[0]!.text, 'User corrected their message');
    assert.equal(recent.items[0]!.speaker, 'system');
    assert.deepEqual(recent.items[0]!.revision, { version: 2, text: 'Correct wording', attachments: currentAttachments });
    const older = (await f.request('GET', '/timeline', { query: { before: recent.before!, limit: 1 } })).body as TimelinePage;
    assert.equal(older.items[0]!.id, publication.id);
    assert.equal(older.items[0]!.text, 'Correct wording');
    assert.deepEqual(older.items[0]!.attachments, currentAttachments);
    assert.deepEqual(older.items[0]!.revision, recent.items[0]!.revision);
    assert.equal(older.watermark, correction.sequence);
    const plain = f.db.list('publications');
    assert.deepEqual(plain.items, before.publications);
    assert.equal(plain.items[0]!.text, 'Old wording');
    assert.deepEqual(plain.items[0]!.attachments, originalAttachments);
    const receipt = (await f.request('GET', '/inputs/:requestId',
      { params: { requestId: 'corrected-user' } })).body as InputReceipt;
    assert.equal(receipt.input.text, 'Old wording');
    assert.deepEqual(receipt.input.attachments, originalAttachments);
    assert.deepEqual({
      publications: f.db.list('publications').items, work: f.db.list('work').items,
      operations: f.db.list('operations').items, messages: f.db.list('messages').items, version: f.service.version,
    }, before);
    assert.equal(f.calls.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('native corrections update the displayed reply without mutating original publication snapshots', () => {
  const f = setup();
  try {
    stageDelivery(f, { state: 'accepted', nativeMessageId: 'assistant-prompt',
      interactionId: 'assistant-interaction', interactionState: 'active',
      result: { ok: true, messageId: 'assistant-prompt' } });
    const events = (version: number) => [
      { id: 'assistant-prompt-event', type: 'user.message', parentId: null,
        data: { content: 'Relevant split prompt', messageId: 'assistant-prompt', interactionId: 'assistant-interaction' } },
      { id: `start-${version}`, type: 'assistant.turn_start', parentId: 'assistant-prompt-event',
        data: { turnId: '0' } },
      { id: `message-${version}`, type: 'assistant.message', parentId: `start-${version}`,
        data: { messageId: 'native-output', content: `Native text ${version}`, toolRequests: [],
          interactionId: 'assistant-interaction',
          attachments: [{ type: 'file', path: `/synthetic/result-${version}.txt` }] } },
      { id: `end-${version}`, type: 'assistant.turn_end', parentId: `message-${version}`,
        data: { turnId: '0' } },
    ];
    f.runtime.ingestion.apply('s1', 1, events(1), 'cursor-1');
    const message = f.db.find('messages', item => item.kind === 'reply')[0]!;
    const oldPublication = f.db.find('publications', item => item.messageId === message.id && item.type === 'message')[0]!;
    f.runtime.ingestion.apply('s1', 1, events(2), 'cursor-2');
    const current = f.db.must('messages', message.id);
    const correction = f.db.find('publications', item => item.type === 'correction')[0]!;
    const corrected = timelineItem(f.service, oldPublication);
    assert.equal(corrected.text, 'Native text 2');
    assert.deepEqual(corrected.attachments, current.attachments);
    assert.deepEqual(timelineItem(f.service, correction).revision, {
      version: 2, text: 'Native text 2', attachments: current.attachments,
    });
    assert.deepEqual(f.db.must('publications', oldPublication.id), oldPublication);
    assert.equal(f.db.find('publications', item => item.messageId === message.id && item.type === 'message').length, 1);
    assert.equal(f.db.meta<{ raw: string }>(`revision:${message.id}:1`, { raw: '' }).raw, 'Native text 1');
  } finally { f.close(); }
});

test('source corrections update the reply projection while preserving topic attribution and original snapshots', () => {
  const f = setup();
  try {
    const message = f.service.addMessage({ kind: 'reply', raw: 'Detailed original answer', sessionId: 's1' });
    const publication = f.service.publish({ type: 'message', messageId: message.id, text: message.raw,
      sources: [ref(message)] });
    const assigned = topic(f.db, 'Reclassified topic');
    f.db.put('messages', { ...message, topicId: assigned.id, assignmentVersion: 1 });
    assert.equal(f.db.must('messages', message.id).assignmentVersion, 1);
    assert.equal(timelineItem(f.service, publication).text, 'Detailed original answer');
    assert.deepEqual(timelineItem(f.service, publication).revision, { version: 1, text: message.raw, attachments: [] });
    f.service.correct(message.id, 'New detailed answer', 1, 'Native source correction');
    assert.equal(timelineItem(f.service, publication).text, 'New detailed answer');
    assert.equal(timelineItem(f.service, publication).revision!.version, 2);
    assert.equal(f.db.must('messages', message.id).topicId, assigned.id);
    assert.equal(f.db.must('messages', message.id).assignmentVersion, 1);
    assert.deepEqual(f.db.must('publications', publication.id), publication);
  } finally { f.close(); }
});

test('clarifications retain their own wording and never inherit source revisions', () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'clarification-source', text: 'Which one is better?' });
    const clarification = f.service.publish({ type: 'clarification', messageId: input.message.id,
      text: 'Do you mean the first project or the second?', sources: [ref(input.message)] });
    const attribution = f.service.publish({ type: 'attribution', messageId: input.message.id, text: input.message.raw });
    f.service.correct(input.message.id, 'Changed user wording', 1, 'Correction');
    const item = timelineItem(f.service, clarification);
    assert.equal(item.text, clarification.text);
    assert.equal(item.speaker, 'assistant');
    assert.equal('revision' in item, false);
    assert.equal(timelineItem(f.service, attribution).revision?.text, 'Changed user wording');
    const standalone = timelineItem(f.service, f.service.publish({ type: 'status', text: 'Native wake accepted' }));
    assert.equal(standalone.speaker, 'system');
    assert.equal('revision' in standalone, false);
  } finally { f.close(); }
});

test('internal carriers and system sources are not assistant speech; ordinary disabled history remains speech', () => {
  const f = setup();
  try {
    for (const sessionId of ['coordinator', 'memory']) {
      const message = f.service.addMessage({ kind: 'reply', raw: 'Internal role output', sessionId });
      const publication = f.service.publish({ type: 'message', messageId: message.id, text: message.raw });
      assert.equal(timelineItem(f.service, publication).speaker, 'system');
      const question = f.service.publish({ type: 'question', messageId: message.id, text: 'Internal question' });
      assert.equal(timelineItem(f.service, question).speaker, 'system');
    }
    const system = f.service.addMessage({ kind: 'system', raw: 'Internal lifecycle event', sessionId: 's1' });
    for (const type of ['message', 'question', 'clarification'] as const) {
      const publication = f.service.publish({ type, messageId: system.id, text: system.raw });
      assert.equal(timelineItem(f.service, publication).speaker, 'system');
    }
    const ordinary = f.service.addMessage({ kind: 'reply', raw: 'A historical answer about coordinator design',
      sessionId: 's1', historical: true });
    f.db.put('receptions', { ...f.db.must('receptions', 's1'), enabled: false, availability: 'missing' });
    const history = f.service.publish({ type: 'message', messageId: ordinary.id, text: ordinary.raw,
      sources: [ref(ordinary)] });
    assert.equal(timelineItem(f.service, history).speaker, 'assistant');
    assert.deepEqual(f.db.must('publications', history.id), history);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('readiness rechecks both roles passively every time and inspect only reads the exact session', async () => {
  const f = setup();
  try {
    const ready = (await f.request('GET', '/readiness')).body as Readiness;
    assert.equal(ready.canSend, true);
    assert.deepEqual(ready.roles.map(role => role.status), ['ready', 'ready']);
    const firstCount = f.calls.length;
    const meta = f.metas.get('memory')!;
    f.metas.set('memory', { ...meta, loaded: false });
    const unavailable = (await f.request('GET', '/readiness')).body as Readiness;
    assert.equal(unavailable.canSend, false);
    assert.equal(unavailable.roles[1]!.status, 'unloaded');
    assert.equal(f.db.must('bindings', 'memory').ready, false);
    assert.ok(f.calls.length > firstCount);
    f.metas.set('s1', { ...f.metas.get('s1')!, loaded: false });
    f.metas.delete('s2');
    const freshReceptions = (await f.request('GET', '/readiness')).body as Readiness;
    assert.deepEqual(freshReceptions.receptions.map(item => item.availability), ['unloaded', 'missing']);
    assert.equal(f.db.must('receptions', 's1').availability, 'loaded');
    f.metas.set('s1', { ...f.metas.get('s1')!, loaded: true });
    f.calls.length = 0;
    const inspection = await f.request('GET', '/sessions/:id/inspect', { params: { id: 's1' } });
    assert.deepEqual(inspection.body, { sessionId: 's1', modelId: 'synthetic', cwd: '/synthetic',
      loaded: true, status: 'idle', rolesNeedReload: null });
    assert.deepEqual(f.calls, [{ name: 'session/get', body: { sessionId: 's1' } }]);
    assert.equal((await f.request('GET', '/sessions/:id/inspect', { params: { id: 'missing' } })).status, 404);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('readiness distinguishes unbound, invalid and unknown without repairing sessions', async () => {
  const f = setup();
  try {
    f.db.sql.prepare('DELETE FROM bindings WHERE id=?').run('coordinator');
    f.metas.set('memory', { ...f.metas.get('memory')!, currentModelId: 'different' });
    const invalid = await f.runtime.readiness();
    assert.deepEqual(invalid.roles.map(role => role.status), ['unbound', 'invalid']);
    f.native.host.call = async () => { throw new Error('Host unavailable'); };
    const unknown = await f.runtime.readiness();
    assert.equal(unknown.roles[1]!.status, 'unknown');
    assert.ok(unknown.receptions.every(item => item.availability === 'unknown'));
    assert.equal(unknown.canSend, false);
    assert.ok(f.calls.every(call => call.name === 'session/get' || call.name === 'roles/readiness'));
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('readiness rejects replaced bindings even if their predecessors verified successfully', async () => {
  const f = setup();
  try {
    const call = f.native.host.call.bind(f.native.host);
    f.native.host.call = async (name, body) => {
      const result = await call(name, body);
      if (name === 'roles/readiness' && 'sessionId' in body && body.sessionId === 'memory') {
        f.db.put('bindings', { ...f.db.must('bindings', 'coordinator'), epoch: 2, ready: false });
      }
      return result;
    };
    const ready = await f.runtime.readiness();
    assert.equal(ready.canSend, false);
    assert.equal(ready.roles[0]!.epoch, 2);
    assert.equal(ready.roles[0]!.status, 'unknown');
    assert.equal(f.db.must('bindings', 'coordinator').ready, false);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('new HTTP input requires both fresh roles, but identical durable replay ignores later readiness', async () => {
  const f = setup();
  try {
    const body = { requestId: 'input-one', text: 'Please help' };
    const first = await f.request('POST', '/messages', { body });
    assert.equal(first.status, undefined);
    assert.ok(f.calls.some(call => call.name === 'roles/readiness'
      && (call.body as { sessionId: string }).sessionId === 'memory'));
    f.metas.set('memory', { ...f.metas.get('memory')!, loaded: false });
    f.calls.length = 0;
    assert.deepEqual((await f.request('POST', '/messages', { body })).body, first.body);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request('POST', '/messages', { body: { ...body, text: 'Different' } })).status, 409);
    const refused = await f.request('POST', '/messages', { body: { ...body, requestId: 'new-input' } });
    assert.equal(refused.status, 409);
    assert.equal(f.db.get('operations', 'input:new-input'), undefined);
    assert.equal(f.db.list('messages').items.length, 1);
    assert.equal(f.db.list('work').items.length, 1);
  } finally { f.close(); }
});

test('exact input receipts track current work and delivery without enqueueing or scanning host sessions', async () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'durable-input', text: 'Hello' });
    f.db.put('work', { ...input.work, state: 'done' });
    f.db.put('deliveries', { id: 'greeting-delivery', kind: 'prompt', messageId: input.message.id,
      sessionId: 's1', requestId: null, text: 'Hello', attachments: [], supplement: null,
      answerFreeform: null, state: 'pending', result: null, error: null, createdAt: 1, roleEpoch: null });
    const receipt = (await f.request('GET', '/inputs/:requestId',
      { params: { requestId: 'durable-input' } })).body as InputReceipt;
    assert.equal(receipt.message.id, input.message.id);
    assert.equal(receipt.work[0]!.state, 'done');
    assert.equal(receipt.deliveries.length, 1);
    assert.equal(receipt.deliveries[0]!.state, 'pending');
    assert.deepEqual(receipt.hasMore, { work: false, deliveries: false });
    assert.equal((await f.request('GET', '/inputs/:requestId', { params: { requestId: 'missing' } })).status, 404);
    const id = 'x'.repeat(512);
    f.db.put('operations', { id, fingerprint: 'test', state: 'unknown', result: { partial: true } });
    assert.deepEqual((await f.request('GET', '/operations/:id', { params: { id } })).body, f.db.must('operations', id));
    assert.equal((await f.request('GET', '/operations/:id', { params: { id: `${id}x` } })).status, 400);
    assert.equal((await f.request('GET', '/operations/:id', { params: { id: 'missing' } })).status, 404);
    assert.equal(f.calls.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('new input rejects a replacement during verification without creating a durable request', async () => {
  const f = setup();
  try {
    const call = f.native.host.call.bind(f.native.host);
    f.native.host.call = async (name, body) => {
      const result = await call(name, body);
      if (name === 'roles/readiness' && 'sessionId' in body && body.sessionId === 'memory') {
        f.db.put('bindings', { ...f.db.must('bindings', 'memory'), epoch: 2, ready: false });
      }
      return result;
    };
    const response = await f.request('POST', '/messages', { body: { requestId: 'raced', text: 'Do not store' } });
    assert.equal(response.status, 409);
    assert.equal(f.db.get('operations', 'input:raced'), undefined);
    assert.equal(f.db.list('messages').items.length, 0);
    assert.equal(f.db.list('work').items.length, 0);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('UI receipt, timeline, and readiness reads remain bounded without full-table find scans', async () => {
  const f = setup();
  try {
    const input = f.service.accept({ requestId: 'bounded', text: 'Hello' });
    for (let i = 0; i < 110; i++) {
      f.db.put('receptions', { ...f.db.must('receptions', 's1'), id: `extra-${i}` });
      f.db.put('work', { ...input.work, id: `extra-work-${i}` });
      f.service.publish({ type: 'message', messageId: input.message.id, text: 'Hello' });
    }
    f.db.find = () => { throw new Error('Unexpected full-table scan'); };
    const readiness = (await f.request('GET', '/readiness')).body as Readiness;
    assert.equal(readiness.receptions.length, 100);
    assert.equal(readiness.canSend, true);
    const receipt = (await f.request('GET', '/inputs/:requestId',
      { params: { requestId: 'bounded' } })).body as InputReceipt;
    assert.equal(receipt.work.length, 100);
    assert.equal(receipt.hasMore.work, true);
    const page = (await f.request('GET', '/timeline')).body as TimelinePage;
    assert.equal(page.items.length, 50);
    assert.equal(page.items[0]!.speaker, 'user');
    assert.equal(page.hasMore, true);
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

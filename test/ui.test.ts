import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, topic, stageDelivery } from './fixtures.ts';
import { inputReceipt, timeline, timelineItem } from '../src/ui.ts';
import { publicationStream } from '../src/stream.ts';
import type { Readable } from 'node:stream';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { routes } from '../src/http.ts';
import type { ModuleRequest } from '@waksana/cockpit-module-sdk/backend';
import type { TimelineItem, TimelinePage } from '../src/ui-types.ts';
import { deferred } from './fixtures.ts';

function request(query: Record<string, unknown> = {}, params: Record<string, string> = {}): ModuleRequest {
  return { query, params, headers: {}, body: undefined, signal: new AbortController().signal };
}
async function apiSnapshot(f: ReturnType<typeof fixture>, messageId: string, after?: number): Promise<TimelineItem> {
  const route = routes(f.service, f.runtime).find(route => route.path === '/timeline')!;
  const response = await route.handler(request(after === undefined ? {} : { after }));
  const item = (response.body as TimelinePage).items.find(item => item.id === messageId);
  assert.ok(item, 'The current original snapshot must be available');
  return item;
}
async function streamSnapshot(f: ReturnType<typeof fixture>, after: number): Promise<TimelineItem> {
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 3000);
  const route = routes(f.service, f.runtime).find(route => route.path === '/timeline/stream')!;
  const response = await route.handler({ ...request({ after }), signal: controller.signal });
  const iterator = (response.body as Readable)[Symbol.asyncIterator]();
  try {
    const next = await iterator.next();
    assert.equal(next.done, false, 'SSE must publish the changed original before the deadline');
    const data = String(next.value).split('\n').find(line => line.startsWith('data: '));
    assert.ok(data);
    return JSON.parse(data.slice(6)) as TimelineItem;
  } finally { controller.abort(); clearTimeout(deadline); await iterator.return?.(); }
}

test('timeline always displays the immutable original once, combined topic titles, and no split bodies or colors', () => {
  const f = fixture();
  try {
    topic(f, 'a'); topic(f, 'b');
    const staged = stageDelivery(f, 'input', ['a','b']);
    const item = timelineItem(f.service, f.db.must('messages', staged.message.id));
    assert.equal(item.id, staged.message.id); assert.equal(item.text, 'Original compound input');
    assert.equal(item.topicTitle, '关于a和b'); assert.equal('topicColor' in item, false);
    assert.deepEqual(item.clarifications, []);
    assert.equal('clarificationHistory' in item, false);
    assert.equal('clarification' in item, false);
    assert.equal(timeline(f.service, undefined, undefined, 50).items.length, 1);
    assert.equal(item.sequence, staged.message.sequence);
    assert.deepEqual(inputReceipt(f.service, 'input').input, { requestId: 'input', text: 'Original compound input', attachments: [] });
    assert.equal(inputReceipt(f.service, 'input').topicMessages.length, 2);
  } finally { f.close(); }
});
test('display sequence never changes; revisions drive attribution, topic definition, clarification, and failure snapshots', async () => {
  const f = fixture();
  try {
    topic(f);
    const m = f.service.accept({ requestId: 'revision', text: 'Raw' }).message;
    const q = f.service.clarify({ messageId: m.id, question: 'Meaning?' }).clarification;
    let updated = f.db.must('messages', m.id);
    assert.ok(updated.revision > m.revision);
    assert.equal(timeline(f.service, undefined, m.revision, 100).items[0]!.clarifications[0]!.id, q.id);
    f.service.answerClarification(m.id, q.id, { requestId: 'answer', answer: 'Known' });
    assert.equal(timelineItem(f.service, f.db.must('messages', m.id)).clarifications.some(entry => entry.answer === null), false);
    f.service.complete({ messageId: m.id, items: [{ topicId: 'topic', prompt: 'Clarified' }] });
    const beforeTitle = f.db.watermark;
    const t = f.db.must('topics', 'topic');
    f.db.put('topics', { ...t, title: 'Renamed', version: t.version + 1 });
    updated = f.db.must('messages', m.id);
    assert.ok(updated.revision > beforeTitle);
    assert.equal(updated.sequence, m.sequence);
    f.promptResult('s1', { ok: false });
    await f.runtime.wake();
    const item = timeline(f.service, undefined, beforeTitle, 100).items[0]!;
    assert.equal(item.topicTitle, 'Renamed'); assert.equal(item.deliveryIssues[0]!.state, 'rejected');
    assert.equal(item.clarifications[0]!.answer, 'Known');
  } finally { f.close(); }
});
test('before uses raw sequence and after uses snapshot revision, including real revision gaps', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) f.service.accept({ requestId: `m${i}`, text: `Raw ${i}` });
    const initial = timeline(f.service, undefined, undefined, 2);
    assert.deepEqual(initial.items.map(item => item.sequence), [3,4]); assert.equal(initial.hasMore, true);
    const older = timeline(f.service, initial.before!, undefined, 2);
    assert.deepEqual(older.items.map(item => item.sequence), [1,2]);
    const oldest = f.db.find('messages', m => m.sequence === 1)[0]!;
    const watermark = f.db.watermark;
    f.db.put('messages', { ...oldest, diagnostic: 'Known diagnostic' });
    f.db.put('messages', { ...f.db.must('messages', oldest.id), diagnostic: 'Newer diagnostic' });
    const delta = timeline(f.service, undefined, watermark, 100);
    assert.equal(delta.items.length, 1);
    assert.equal(delta.items[0]!.sequence, 1); assert.ok(delta.items[0]!.snapshotRevision > watermark + 1);
  } finally { f.close(); }
});
test('SSE publication IDs are snapshotRevision, not display sequence', async () => {
  const f = fixture(), controller = new AbortController();
  try {
    const m = f.service.accept({ requestId: 'stream', text: 'Raw' }).message;
    f.service.clarify({ messageId: m.id, question: 'Meaning?' });
    const current = f.db.must('messages', m.id);
    const response = publicationStream(f.service, m.revision, controller.signal, message => timelineItem(f.service, message));
    const stream = response.body as Readable;
    const iterator = stream[Symbol.asyncIterator]();
    const value = String((await iterator.next()).value);
    assert.ok(value.startsWith(`id: ${current.revision}\n`));
    assert.ok(value.includes('"sequence":1'));
    controller.abort(); await iterator.return?.();
  } finally { controller.abort(); f.close(); }
});
test('internalization retires queued processing without suppressing already saved real ordinary originals', () => {
  const f = fixture();
  try {
    topic(f);
    const complete = f.service.addMessage({ kind: 'reply', raw: 'Completed ordinary raw', attachments: [],
      sessionId: 's1', nativeMessageId: 'completed' });
    f.service.complete({ messageId: complete.id, items: [{ topicId: 'topic' }] });
    const queued = f.service.addMessage({ kind: 'reply', raw: 'Queued ordinary raw', attachments: [],
      sessionId: 's1', nativeMessageId: 'queued' });
    f.service.excludeSession('s1');
    assert.equal(f.db.must('messages', complete.id).excluded, false);
    const original = f.db.must('messages', queued.id);
    assert.equal(original.excluded, true);
    assert.equal(timelineItem(f.service, original).speaker, 'assistant');
    assert.equal(timelineItem(f.service, original).text, 'Queued ordinary raw');
    assert.ok(timelineItem(f.service, original).diagnostic);
    assert.equal(f.db.eligible(), undefined);
  } finally { f.close(); }
});
test('an archived topic can still attribute a real native reply without reopening routing or rewriting its original', () => {
  const f = fixture();
  try {
    const t = topic(f);
    f.db.put('topics', { ...t, archived: true });
    const source = f.service.addMessage({ kind: 'reply', raw: 'Raw after archive', attachments: [],
      sessionId: 's1', nativeMessageId: 'archive-reply' });
    f.service.complete({ messageId: source.id, items: [{ topicId: 'topic' }] });
    assert.equal(f.db.must('topics', 'topic').archived, true);
    assert.equal(timelineItem(f.service, f.db.must('messages', source.id)).text, 'Raw after archive');
  } finally { f.close(); }
});
test('normal in-flight and accepted coordinator guards remain durable but are not public timeline or SSE errors', async () => {
  const f = fixture(), promptEntered = deferred(), releasePrompt = deferred();
  let pumping: Promise<void> | undefined;
  try {
    const original = f.service.accept({ requestId: 'normal-active', text: 'Normal source' }).message;
    f.onPrompt(async sessionId => {
      if (sessionId === 'coordinator') { promptEntered.resolve(); await releasePrompt.promise; }
    });
    pumping = f.runtime.wake();
    await promptEntered.promise;
    assert.ok(f.db.must('messages', original.id).diagnostic, 'In-flight crash protection is persisted');
    assert.equal((await apiSnapshot(f, original.id)).diagnostic, null);
    const itemRoute = routes(f.service, f.runtime).find(route => route.path === '/timeline/items/:sequence')!;
    assert.equal(((await itemRoute.handler(request({}, { sequence: String(original.sequence) }))).body as TimelineItem).diagnostic, null);
    assert.equal((await streamSnapshot(f, original.revision)).diagnostic, null);
    releasePrompt.resolve();
    await pumping;
    assert.ok(f.db.must('messages', original.id).diagnostic, 'Successful acceptance must not clear crash protection');
    assert.equal((await apiSnapshot(f, original.id)).diagnostic, null);
    assert.equal((await streamSnapshot(f, original.revision)).diagnostic, null);
    f.db.put('messages', { ...f.db.must('messages', original.id), diagnostic: 'A different real error' });
    assert.equal((await apiSnapshot(f, original.id)).diagnostic, 'A different real error', 'Active source must not hide other diagnostics');
  } finally { releasePrompt.resolve(); await pumping; f.close(); }
});
for (const outcome of ['rejected','thrown','missing-receipt'] as const)
  test(`coordinator ${outcome} remains visible in API/SSE and is not resent`, async () => {
    const f = fixture();
    try {
      const original = f.service.accept({ requestId: outcome, text: 'Source with real failure' }).message;
      if (outcome === 'rejected') f.promptResult('coordinator', { ok: false });
      else if (outcome === 'missing-receipt') f.promptResult('coordinator', { ok: true });
      else f.fail('prompt', new Error('Native coordinator transport failed'));
      await f.runtime.wake();
      const stored = f.db.must('messages', original.id);
      assert.ok(stored.diagnostic);
      assert.equal((await apiSnapshot(f, original.id)).diagnostic, stored.diagnostic);
      assert.equal((await streamSnapshot(f, original.revision)).diagnostic, stored.diagnostic);
      await f.runtime.wake(); await f.runtime.wake();
      assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
      assert.equal(f.db.must('messages', original.id).processed, false);
    } finally { f.close(); }
  });
test('a coordinator finish without semantic result replaces the hidden guard with a visible API/SSE error', async () => {
  const f = fixture();
  try {
    const original = f.service.accept({ requestId: 'unfinished', text: 'Unfinished source' }).message;
    await f.runtime.wake();
    assert.equal((await apiSnapshot(f, original.id)).diagnostic, null);
    const receipt = f.sourceReceipts.get(original.id)!;
    const interactionId = `interaction:${receipt}`;
    await f.event('coordinator', { id: `envelope:${receipt}`, type: 'user.message',
      data: { messageId: receipt, interactionId } });
    const guardRevision = f.db.must('messages', original.id).revision;
    await f.event('coordinator', { id: 'finish-without-result', type: 'assistant.turn_end', data: { interactionId } });
    const stored = f.db.must('messages', original.id);
    assert.ok(stored.diagnostic?.includes('finished without a saved result'));
    assert.equal((await apiSnapshot(f, original.id, guardRevision)).diagnostic, stored.diagnostic);
    assert.equal((await streamSnapshot(f, guardRevision)).diagnostic, stored.diagnostic);
    await f.runtime.wake();
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  } finally { f.close(); }
});
test('restart republishes a formerly hidden accepted guard as unknown for API and resumed SSE without replay', async () => {
  const root = join(process.cwd(), 'node_modules/.cache', `assistant-diagnostic-restart-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, 'assistant.sqlite');
  let f = fixture(path);
  try {
    const original = f.service.accept({ requestId: 'accepted-before-crash', text: 'Persisted source' }).message;
    await f.runtime.wake();
    const guard = f.db.must('messages', original.id);
    assert.ok(guard.diagnostic);
    assert.equal((await apiSnapshot(f, original.id)).diagnostic, null);
    await f.runtime.settled();
    f.close(); f = fixture(path);
    await f.runtime.start();
    const resumed = await apiSnapshot(f, original.id, guard.revision);
    assert.equal(resumed.diagnostic, guard.diagnostic);
    assert.ok(resumed.snapshotRevision > guard.revision);
    const streamed = await streamSnapshot(f, guard.revision);
    assert.equal(streamed.id, original.id);
    assert.equal(streamed.diagnostic, guard.diagnostic);
    await f.runtime.wake();
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    assert.equal(f.db.must('messages', original.id).processed, false);
  } finally { await f.runtime.settled(); f.close(); rmSync(root, { recursive: true }); }
});

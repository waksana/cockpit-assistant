import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { fixture, topic, toolIdentity, stageDelivery, deferred } from './fixtures.ts';
import { timelineItem } from '../src/ui.ts';

const coordinatorPrompts = (f: ReturnType<typeof fixture>) => f.calls.filter(call =>
  call.name === 'prompt' && (call.body as { sessionId: string }).sessionId === 'coordinator');
test('scheduler sends exactly one raw original, not a batch, and commits before user delivery', async () => {
  const f = fixture();
  try {
    topic(f);
    const first = f.service.accept({ requestId: 'first', text: 'First raw' }).message;
    const second = f.service.accept({ requestId: 'second', text: 'Second raw' }).message;
    await Promise.all([f.runtime.wake(), f.runtime.wake(), f.runtime.wake()]);
    assert.equal(coordinatorPrompts(f).length, 1);
    const prompt = (coordinatorPrompts(f)[0]!.body as { text: string }).text;
    assert.ok(prompt.includes(first.id)); assert.ok(prompt.includes('First raw')); assert.equal(prompt.includes(second.id), false);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    await f.runtime.complete(toolIdentity(f, first.id), { messageId: first.id, items: [{ topicId: 'topic', prompt: 'First split' }] });
    assert.equal(f.db.must('messages', first.id).processed, true);
    assert.equal(f.db.topicMessages(first.id)[0]!.state, 'pending');
    f.onPrompt(async sessionId => {
      if (sessionId === 's1') assert.equal(f.db.must('messages', first.id).processed, true);
    });
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 2);
    assert.equal(f.db.topicMessages(first.id)[0]!.state, 'accepted');
    assert.equal(f.db.must('messages', second.id).processed, false);
    assert.equal(f.db.find('messages', () => true).length, 2);
  } finally { f.close(); }
});
test('stale native tool cannot adopt whichever newer original is active, while known completed results stay idempotent', async () => {
  const f = fixture();
  try {
    topic(f);
    const a = f.service.accept({ requestId: 'a', text: 'A' }).message;
    const b = f.service.accept({ requestId: 'b', text: 'B' }).message;
    await f.runtime.wake();
    const identity = toolIdentity(f, a.id);
    const value = { messageId: a.id, items: [{ topicId: 'topic', prompt: 'A' }] };
    await f.runtime.complete(identity, value);
    await f.runtime.wake();
    await assert.rejects(f.runtime.complete(identity, { ...value, messageId: b.id }), /exact source receipt/);
    assert.equal(f.db.must('messages', b.id).processed, false);
    const count = f.db.topicMessages(a.id).length;
    assert.equal((await f.runtime.complete(identity, value)).alreadyProcessed, true);
    assert.equal(f.db.topicMessages(a.id).length, count);
  } finally { f.close(); }
});
test('native receipt uses data.messageId, never the event envelope, and subagent hooks are rejected', async () => {
  const f = fixture();
  try {
    const m = f.service.accept({ requestId: 'native', text: 'Raw' }).message;
    await f.runtime.wake();
    const hook = toolIdentity(f, m.id);
    const receipt = f.sourceReceipts.get(m.id)!;
    const root = f.history.get('coordinator')!.find(event => event.type === 'user.message')!;
    assert.equal(root.id, `envelope:${receipt}`);
    assert.equal(root.data.messageId, receipt);
    assert.equal((await f.runtime.authorize(hook, m.id)).messageId, m.id);
    assert.equal((await f.runtime.authorize({ ...hook, agentName: 'named-primary' }, m.id)).messageId, m.id);
    await assert.rejects(f.runtime.authorize({ ...hook, subagent: true }, m.id), /primary native/);
    await assert.rejects(f.runtime.authorize({ ...hook, runtimeSessionId: 'other' }, m.id), /primary native/);
    const fake = toolIdentity(f, m.id, 'fake-envelope-root', `envelope:${receipt}`);
    await assert.rejects(f.runtime.authorize(fake, m.id), /exact source receipt/);
  } finally { f.close(); }
});
test('local clarification frees the coordinator for another source, does not native-ask or repeatedly dispatch waiting original', async () => {
  const f = fixture();
  try {
    topic(f);
    const a = f.service.accept({ requestId: 'a', text: 'Ambiguous original' }).message;
    const b = f.service.accept({ requestId: 'b', text: 'Clear original' }).message;
    await f.runtime.wake();
    const old = toolIdentity(f, a.id);
    const q = (await f.runtime.clarify(old, { messageId: a.id, question: 'Which destination?' })).clarification;
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 2);
    assert.equal(f.db.must('messages', a.id).processed, false);
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
    await f.runtime.complete(toolIdentity(f, b.id), { messageId: b.id, items: [{ topicId: 'topic', prompt: 'Clear split' }] });
    await f.runtime.wake(); await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 2);
    f.service.answerClarification(a.id, q.id, { requestId: 'answer', answer: 'Destination A' });
    await assert.rejects(f.runtime.complete(old, { messageId: a.id, items: [{ topicId: 'topic', prompt: 'stale decision' }] }), /current source/);
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 3);
    const prompt = (coordinatorPrompts(f).at(-1)!.body as { text: string }).text;
    assert.ok(prompt.includes('Ambiguous original')); assert.ok(prompt.includes('Destination A'));
    await assert.rejects(f.runtime.clarify(old, { messageId: a.id, question: 'Stale?' }), /exact source receipt/);
  } finally { f.close(); }
});
test('waiting and answered clarification survive restart; uncertain coordinator calls do not automatically repeat', async () => {
  const root = join(process.cwd(), 'node_modules/.cache', `assistant-restart-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, 'assistant.sqlite');
  let f = fixture(path);
  try {
    const waiting = f.service.accept({ requestId: 'waiting', text: 'Waiting raw' }).message;
    const q = f.service.clarify({ messageId: waiting.id, question: 'Meaning?' }).clarification;
    const uncertain = f.service.accept({ requestId: 'uncertain', text: 'Unknown raw' }).message;
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 1);
    f.close(); f = fixture(path);
    await f.runtime.start();
    assert.equal(coordinatorPrompts(f).length, 0);
    assert.equal(f.db.must('messages', waiting.id).clarification!.id, q.id);
    assert.ok(f.db.must('messages', uncertain.id).diagnostic);
    assert.ok(f.errors.some(error => (error as { messageId?: string }).messageId === uncertain.id));
    f.service.answerClarification(waiting.id, q.id, { requestId: 'persisted-answer', answer: 'Known' });
    f.close(); f = fixture(path);
    await f.runtime.start();
    assert.equal(coordinatorPrompts(f).length, 1);
    assert.equal(f.db.must('messages', waiting.id).clarificationHistory[0]!.answer, 'Known');
    assert.equal(f.db.must('messages', uncertain.id).processed, false);
  } finally { f.close(); rmSync(root, { recursive: true }); }
});
test('multi-topic user prompts retain attachments and real frozen targets; busy sessions use normal enqueue', async () => {
  const f = fixture();
  try {
    topic(f, 'a', 's1'); topic(f, 'b', 's2');
    f.metas.get('s1')!.status = 'running';
    const attachment = { type: 'file' as const, path: '/synthetic/input' };
    const staged = stageDelivery(f, 'multi', ['a','b'], [attachment]);
    await f.runtime.wake();
    const sends = f.calls.filter(call => call.name === 'prompt') as { body: { sessionId: string; mode: string; attachments: unknown } }[];
    assert.equal(sends.length, 2);
    assert.deepEqual(sends.map(call => call.body.sessionId), ['s1','s2']);
    for (const send of sends) { assert.equal(send.body.mode, 'enqueue'); assert.deepEqual(send.body.attachments, [attachment]); }
    assert.equal(f.db.topicMessages(staged.message.id).every(row => row.state === 'accepted'), true);
    const a = f.db.must('topics', 'a');
    f.db.put('topics', { ...a, sessionId: 's2', version: a.version + 1 });
    assert.equal(f.db.topicMessages(staged.message.id).find(row => row.topicId === 'a')!.sessionId, 's1');
    assert.throws(() => f.db.put('topic_messages', { ...f.db.topicMessages(staged.message.id)[0]!, sessionId: 's2' }), /retains its actual target/);
  } finally { f.close(); }
});
for (const state of ['rejected','unknown'] as const) test(`native ${state} is visible on the original, reported, revisioned and not retried`, async () => {
  const f = fixture();
  try {
    const result = stageDelivery(f);
    const originalRevision = f.db.must('messages', result.message.id).revision;
    if (state === 'rejected') f.promptResult('s1', { ok: false });
    else f.fail('prompt', new Error('Connection lost after native may have accepted'));
    await f.runtime.wake();
    const row = f.db.topicMessages(result.message.id)[0]!;
    assert.equal(row.state, state);
    assert.ok(f.errors.some(error => (error as { topicMessageId?: string }).topicMessageId === row.id));
    const message = f.db.must('messages', result.message.id);
    assert.ok(message.revision > originalRevision);
    assert.equal(timelineItem(f.service, message).deliveryIssues[0]!.state, state);
    const sends = f.calls.filter(call => call.name === 'prompt').length;
    await f.runtime.wake(); await f.runtime.wake();
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, sends);
    assert.equal(message.processed, true);
  } finally { f.close(); }
});
test('unloaded original target is loaded by the original ID, never replaced', async () => {
  const f = fixture();
  try {
    f.metas.get('s1')!.loaded = false; f.metas.get('s1')!.status = 'unloaded';
    stageDelivery(f);
    await f.runtime.wake();
    assert.deepEqual(f.calls.find(call => call.name === 'session/load')!.body, { sessionId: 's1' });
    assert.equal(f.calls.some(call => call.name === 'session/new'), false);
    assert.equal(f.db.find('topic_messages', () => true)[0]!.state, 'accepted');
  } finally { f.close(); }
});
test('role discovery is coordinator-only; competing carriers are ambiguous and saved/unapplied roles stay invalid', async () => {
  const f = fixture();
  try {
    assert.equal((await f.runtime.readiness()).roles.length, 1);
    assert.equal((await f.runtime.readiness()).canSend, true);
    f.metas.get('coordinator')!.rolesNeedReload = true;
    assert.equal((await f.runtime.readiness()).roles[0]!.status, 'invalid');
    f.metas.get('coordinator')!.rolesNeedReload = false;
    f.metas.get('s2')!.roles = f.metas.get('coordinator')!.roles;
    assert.equal((await f.runtime.readiness()).roles[0]!.status, 'ambiguous');
    await assert.rejects(f.runtime.acceptReady({ requestId: 'not-ready', text: 'Raw' }), /ready native coordinator/);
  } finally { f.close(); }
});
test('ordinary to internal transition retires queued replies, questions and unsent business sends', async () => {
  const f = fixture();
  try {
    const question = f.service.question('s1', { requestId: 'ordinary-ask', question: 'Ordinary?' })!;
    const staged = stageDelivery(f);
    f.runtime.noteEvent('s1', { id: 'queued-reply', type: 'assistant.message', data: { content: 'No longer business' } });
    f.metas.get('s1')!.roles = f.metas.get('coordinator')!.roles;
    await f.runtime.wake('s1');
    assert.equal(f.db.must('messages', question.id).excluded, true);
    assert.equal(f.db.must('messages', question.id).question!.state, 'stale');
    assert.equal(f.db.find('messages', m => m.nativeEventId === 'queued-reply').length, 0);
    assert.equal(f.db.topicMessages(staged.message.id)[0]!.state, 'cancelled');
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    assert.ok(f.errors.some(error => (error as { state?: string }).state === 'cancelled'));
  } finally { f.close(); }
});
test('real target verification rejects invented handoff identity before any semantic writes', async () => {
  const f = fixture();
  try {
    topic(f);
    const source = f.service.addMessage({ kind: 'reply', raw: 'I assigned session invented to handle this.',
      attachments: [], sessionId: 's1', nativeMessageId: 'handoff' });
    await f.runtime.wake();
    await assert.rejects(f.runtime.complete(toolIdentity(f, source.id), { messageId: source.id,
      topics: [{ topicId: 'topic', title: 'topic', content: '', sessionId: 'invented' }], items: [{ topicId: 'topic' }] }), /real ordinary/);
    assert.equal(f.db.must('topics', 'topic').sessionId, 's1');
    assert.equal(f.db.must('messages', source.id).processed, false);
  } finally { f.close(); }
});
test('hook arriving before public prompt receipt waits for that exact receipt, never invents provenance', async () => {
  const f = fixture();
  try {
    const m = f.service.accept({ requestId: 'early-hook', text: 'Raw' }).message;
    const receipt = 'true-early-receipt';
    f.promptResult('coordinator', { ok: true, messageId: receipt });
    const hook = toolIdentity(f, m.id, 'early-call', receipt);
    let authorization: ReturnType<typeof f.runtime.authorize> | undefined;
    f.onPrompt(async sessionId => {
      if (sessionId === 'coordinator') authorization = f.runtime.authorize(hook, m.id);
    });
    await f.runtime.wake();
    assert.equal((await authorization)!.messageId, m.id);
    assert.equal(f.db.must('messages', m.id).processed, false);
  } finally { f.close(); }
});
test('coordinator prompt accepted without receipt remains visible unknown and is never repeated', async () => {
  const f = fixture();
  try {
    const m = f.service.accept({ requestId: 'lost-receipt', text: 'Raw' }).message;
    f.promptResult('coordinator', { ok: true });
    await f.runtime.wake(); await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 1);
    const source = f.db.must('messages', m.id);
    assert.equal(source.processed, false);
    assert.ok(timelineItem(f.service, source).diagnostic?.includes('receipt is missing'));
    assert.ok(f.errors.some(error => (error as { messageId?: string }).messageId === m.id));
  } finally { f.close(); }
});
test('late saved-role notification consults current Host metadata instead of falsely converting an ordinary session', async () => {
  const f = fixture();
  try {
    const source = f.service.addMessage({ kind: 'reply', raw: 'Currently ordinary source', attachments: [],
      sessionId: 's1', nativeMessageId: 'ordinary' });
    await f.runtime.registerRoles('s1', ['coordinator'], 'late-saved');
    assert.equal(f.db.must('messages', source.id).excluded, false);
    f.metas.get('s1')!.roles = f.metas.get('coordinator')!.roles;
    await f.runtime.registerRoles('s1', ['coordinator'], 'current-saved');
    assert.equal(f.db.must('messages', source.id).excluded, true);
  } finally { f.close(); }
});
test('received native red/blue question persists before a later user answer despite delayed source metadata', async () => {
  const f = fixture(), metadataEntered = deferred(), releaseMetadata = deferred();
  let pumping: Promise<void> | undefined;
  try {
    topic(f);
    const ask = { requestId: 'native-red-blue', question: 'Choose exactly red or blue',
      choices: ['red','blue'], allowFreeform: false };
    f.metas.get('s1')!.ask = ask;
    let delayed = false;
    f.onGet(async sessionId => {
      if (sessionId !== 's1' || delayed) return;
      delayed = true;
      metadataEntered.resolve();
      await releaseMetadata.promise;
    });
    f.runtime.noteQuestion('s1', ask);
    pumping = f.runtime.wake('s1');
    await metadataEntered.promise;
    const accepted = f.runtime.acceptReady({ requestId: 'later-blue', text: 'blue' });
    await setImmediate();
    assert.equal(f.db.input('later-blue'), undefined, 'Later user input must not overtake source validation');
    releaseMetadata.resolve();
    const user = (await accepted).message;
    await pumping;
    const originalAsk = f.db.nativeQuestion('s1', ask.requestId)!;
    assert.ok(originalAsk.sequence < user.sequence);
    const firstPrompt = (coordinatorPrompts(f)[0]!.body as { text: string }).text;
    assert.ok(firstPrompt.includes(originalAsk.id));
    assert.equal(firstPrompt.includes(user.id), false);
    await f.runtime.complete(toolIdentity(f, originalAsk.id), { messageId: originalAsk.id, items: [{ topicId: 'topic' }] });
    await f.runtime.wake();
    await f.runtime.complete(toolIdentity(f, user.id), { messageId: user.id, items: [{ topicId: 'topic', prompt: 'blue' }] });
    await f.runtime.wake();
    assert.deepEqual(f.calls.find(call => call.name === 'respondAsk')!.body,
      { sessionId: 's1', requestId: ask.requestId, answer: 'blue', wasFreeform: false });
    assert.equal(f.calls.some(call => call.name === 'prompt' && (call.body as { sessionId: string }).sessionId === 's1'), false);
  } finally { releaseMetadata.resolve(); await pumping; f.close(); }
});
test('received primary reply validation shares the same order boundary as later user admission', async () => {
  const f = fixture(), metadataEntered = deferred(), releaseMetadata = deferred();
  let pumping: Promise<void> | undefined;
  try {
    let delayed = false;
    f.onGet(async sessionId => {
      if (sessionId !== 's1' || delayed) return;
      delayed = true; metadataEntered.resolve(); await releaseMetadata.promise;
    });
    f.runtime.noteEvent('s1', { id: 'earlier-envelope', type: 'assistant.message',
      data: { messageId: 'earlier-native-reply', content: 'Earlier primary reply' } });
    pumping = f.runtime.wake('s1');
    await metadataEntered.promise;
    const accepted = f.runtime.acceptReady({ requestId: 'later-user', text: 'Later user original' });
    await setImmediate();
    assert.equal(f.db.input('later-user'), undefined);
    releaseMetadata.resolve();
    const user = (await accepted).message;
    await pumping;
    assert.ok(f.db.nativeMessage('s1', 'earlier-native-reply')!.sequence < user.sequence);
  } finally { releaseMetadata.resolve(); await pumping; f.close(); }
});
test('a pending coordinator call never holds the source admission boundary or turns its internal events into business', async () => {
  const f = fixture(), promptEntered = deferred(), releasePrompt = deferred(), timeout = new AbortController();
  let pumping: Promise<void> | undefined;
  try {
    f.service.accept({ requestId: 'first-source', text: 'First raw' });
    f.onPrompt(async sessionId => {
      if (sessionId === 'coordinator') { promptEntered.resolve(); await releasePrompt.promise; }
    });
    pumping = f.runtime.wake();
    await promptEntered.promise;
    const accepted = await Promise.race([
      f.runtime.acceptReady({ requestId: 'during-model-call', text: 'Second raw' }),
      setTimeout(3000, undefined, { signal: timeout.signal }).then(() => { throw new Error('Model call blocked original admission'); }),
    ]);
    f.runtime.noteEvent('coordinator', { id: 'internal-tool', type: 'assistant.message',
      data: { content: 'Internal coordinator prose', toolRequests: [{ toolCallId: 'internal-only' }] } });
    f.runtime.noteQuestion('coordinator', { requestId: 'internal-question', question: 'Not business' });
    f.runtime.noteQuestion('s1', { requestId: 'during-model-ask', question: 'Ordinary new question?' });
    await f.runtime.observe('s1');
    const ordinaryAsk = f.db.nativeQuestion('s1', 'during-model-ask')!;
    assert.ok(accepted.message.sequence < ordinaryAsk.sequence);
    assert.equal(f.db.find('messages', message => message.sessionId === 'coordinator').length, 0);
    assert.deepEqual(f.db.find('messages', () => true).map(message => message.raw),
      ['First raw','Second raw','Ordinary new question?']);
  } finally { timeout.abort(); releasePrompt.resolve(); await pumping; f.close(); }
});

for (const endType of ['assistant.turn_end', 'abort'] as const)
  test(`early ${endType} is matched after its actual send receipt and does not block later sources`, async () => {
    const f = fixture();
    try {
      const first = f.service.accept({ requestId: 'ended-first', text: 'First original' }).message;
      const second = f.service.accept({ requestId: 'after-ended', text: 'Later original' }).message;
      const receipt = `early-${endType}`;
      let prompts = 0;
      f.onPrompt(async sessionId => {
        if (sessionId !== 'coordinator') return;
        prompts++;
        f.promptResult('coordinator', { ok: true, messageId: prompts === 1 ? receipt : 'later-receipt' });
        if (prompts !== 1) return;
        f.runtime.noteEvent('coordinator', { id: `envelope:${receipt}`, type: 'user.message',
          data: { messageId: receipt, interactionId: `interaction:${receipt}` } });
        f.runtime.noteEvent('coordinator', { id: 'early-end', type: endType,
          data: { interactionId: `interaction:${receipt}` } });
        await f.runtime.observe('coordinator');
        assert.equal(f.runtime.visibleDiagnostic(f.db.must('messages', first.id)), null);
      });
      await f.runtime.wake();
      const source = f.db.must('messages', first.id);
      assert.equal(source.processed, false);
      assert.match(f.runtime.visibleDiagnostic(source)!, /finished without a saved result/);
      assert.ok(f.errors.some(error => (error as { code?: string }).code === 'COORDINATOR_INCOMPLETE'));
      assert.equal(coordinatorPrompts(f).length, 2);
      assert.ok((coordinatorPrompts(f)[1]!.body as { text: string }).text.includes(second.id));
      await f.runtime.wake(); await f.runtime.wake();
      assert.equal(coordinatorPrompts(f).length, 2, 'The ended original is not automatically resent');
    } finally { f.close(); }
  });

test('early foreign, ephemeral and subagent termination evidence cannot retire a current source', async () => {
  const f = fixture();
  try {
    const first = f.service.accept({ requestId: 'active-first', text: 'Current original' }).message;
    f.service.accept({ requestId: 'later', text: 'Later original' });
    const receipt = 'current-receipt';
    f.promptResult('coordinator', { ok: true, messageId: receipt });
    f.onPrompt(async sessionId => {
      if (sessionId !== 'coordinator') return;
      f.runtime.noteEvent('coordinator', { id: `envelope:${receipt}`, type: 'user.message',
        data: { messageId: receipt, interactionId: `interaction:${receipt}` } });
      f.runtime.noteEvent('coordinator', { id: 'foreign-end', type: 'assistant.turn_end',
        data: { interactionId: 'another-interaction' } });
      f.runtime.noteEvent('coordinator', { id: 'ephemeral-end', type: 'assistant.turn_end', ephemeral: true,
        data: { interactionId: `interaction:${receipt}` } });
      f.runtime.noteEvent('coordinator', { id: 'subagent-abort', type: 'abort', agentId: 'helper',
        data: { interactionId: `interaction:${receipt}` } });
      await f.runtime.observe('coordinator');
    });
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 1);
    assert.equal(f.runtime.visibleDiagnostic(f.db.must('messages', first.id)), null);
    assert.deepEqual(f.errors, []);
    f.onPrompt(null);
    f.promptResult('coordinator', { ok: true, messageId: 'following-receipt' });
    await f.event('coordinator', { id: 'actual-end', type: 'assistant.turn_end',
      data: { interactionId: `interaction:${receipt}` } });
    assert.equal(coordinatorPrompts(f).length, 2);
  } finally { f.close(); }
});

test('internalization during a failed coordinator call preserves the latest source and releases active', async () => {
  const f = fixture();
  try {
    const first = f.service.addMessage({ kind: 'reply', raw: 'Ordinary before internalization',
      attachments: [], sessionId: 's1', nativeMessageId: 'becoming-internal' });
    const next = f.service.accept({ requestId: 'following-source', text: 'Independent user original' }).message;
    const nativeFailure = new Error('Native send response was lost');
    let failed = false;
    f.onPrompt(async sessionId => {
      if (sessionId !== 'coordinator' || failed) return;
      failed = true;
      f.metas.get('s1')!.roles = [{ moduleId: 'assistant', roleId: 'memory', moduleName: 'Assistant', name: 'memory' }];
      await f.runtime.observe('s1');
      assert.equal(f.db.must('messages', first.id).excluded, true);
      throw nativeFailure;
    });
    await f.runtime.wake();
    const source = f.db.must('messages', first.id);
    assert.equal(source.excluded, true);
    assert.match(source.diagnostic!, /internal role carrier/);
    assert.ok(f.errors.some(error => error instanceof Error && error.cause === nativeFailure));
    assert.equal((await f.runtime.readiness()).canSend, true);
    assert.equal(coordinatorPrompts(f).length, 2);
    assert.ok((coordinatorPrompts(f)[1]!.body as { text: string }).text.includes(next.id));
  } finally { f.close(); }
});

test('diagnostic persistence failure still releases the failed invocation and reports both failures', async () => {
  const f = fixture();
  try {
    const first = f.service.accept({ requestId: 'failed-source', text: 'First original' }).message;
    f.service.accept({ requestId: 'following-source', text: 'Next original' });
    const nativeFailure = new Error('Native failure to retain');
    const persistenceFailure = new Error('Diagnostic storage failed');
    const put = f.db.put.bind(f.db);
    f.db.put = (table, value) => {
      if (table === 'messages' && 'diagnostic' in value && value.diagnostic === nativeFailure.message) throw persistenceFailure;
      put(table, value);
    };
    let failed = false;
    f.onPrompt(async sessionId => {
      if (sessionId === 'coordinator' && !failed) { failed = true; throw nativeFailure; }
    });
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 2);
    assert.ok(f.runtime.visibleDiagnostic(f.db.must('messages', first.id)));
    assert.ok(f.errors.some(error => error instanceof Error && error.cause === nativeFailure));
    assert.ok(f.errors.some(error => error instanceof AggregateError && error.errors.includes(persistenceFailure)));
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 2);
  } finally { f.close(); }
});

test('a failed initial processing guard does not reserve active or send a native prompt', async () => {
  const f = fixture();
  try {
    const source = f.service.accept({ requestId: 'guard-failure', text: 'Original' }).message;
    const put = f.db.put.bind(f.db);
    f.db.put = (table, value) => {
      if (table === 'messages' && value.id === source.id) throw new Error('Initial guard failed');
      put(table, value);
    };
    await assert.rejects(f.runtime.wake(), /Initial guard failed/);
    assert.equal(coordinatorPrompts(f).length, 0);
    f.db.put = put;
    await f.runtime.wake();
    assert.equal(coordinatorPrompts(f).length, 1);
  } finally { f.close(); }
});

for (const endType of ['assistant.turn_end', 'abort'] as const)
  test(`history read merges live ${endType} evidence while source observation is delayed`, async () => {
    const f = fixture(), metadataEntered = deferred(), releaseMetadata = deferred(),
      historyEntered = deferred(), releaseHistory = deferred();
    let observation: Promise<void> | undefined;
    try {
      const first = f.service.accept({ requestId: 'history-first', text: 'First source' }).message;
      const next = f.service.accept({ requestId: 'history-next', text: 'Next source' }).message;
      await f.runtime.wake();
      const receipt = f.sourceReceipts.get(first.id)!;
      const identity = toolIdentity(f, first.id, 'during-history');
      let delayed = false;
      f.onGet(async sessionId => {
        if (sessionId !== 's1' || delayed) return;
        delayed = true; metadataEntered.resolve(); await releaseMetadata.promise;
      });
      observation = f.runtime.observe('s1');
      await metadataEntered.promise;
      const read = f.native.read.bind(f.native);
      f.native.read = async (...args) => {
        const page = await read(...args);
        historyEntered.resolve();
        await releaseHistory.promise;
        return page;
      };
      const authorization = assert.rejects(f.runtime.authorize(identity, first.id),
        { code: 'STALE_SOURCE' });
      await historyEntered.promise;
      f.runtime.noteEvent('coordinator', { id: 'tool-envelope:during-history', type: 'assistant.message',
        data: { interactionId: `interaction:${receipt}`, toolRequests: [{ toolCallId: 'during-history' }] } });
      f.runtime.noteEvent('coordinator', { id: `during-history:${endType}`, type: endType,
        data: { interactionId: `interaction:${receipt}` } });
      releaseHistory.resolve();
      await authorization;
      releaseMetadata.resolve();
      await observation;
      await f.runtime.wake();
      assert.equal(f.db.must('messages', first.id).processed, false);
      assert.match(f.runtime.visibleDiagnostic(f.db.must('messages', first.id))!, /finished without a saved result/);
      assert.ok(f.errors.some(error => (error as { code?: string }).code === 'COORDINATOR_INCOMPLETE'));
      assert.equal(coordinatorPrompts(f).length, 2);
      assert.ok((coordinatorPrompts(f)[1]!.body as { text: string }).text.includes(next.id));
    } finally { releaseHistory.resolve(); releaseMetadata.resolve(); await observation; f.close(); }
  });

test('history snapshot cannot discard a tool identity received while the native read is pending', async () => {
  const f = fixture(), historyEntered = deferred(), releaseHistory = deferred();
  try {
    const source = f.service.accept({ requestId: 'live-tool', text: 'Original' }).message;
    await f.runtime.wake();
    const receipt = f.sourceReceipts.get(source.id)!;
    const read = f.native.read.bind(f.native);
    f.native.read = async (...args) => {
      const page = await read(...args);
      historyEntered.resolve();
      await releaseHistory.promise;
      return page;
    };
    const authorization = f.runtime.authorize({
      sessionId: 'coordinator', runtimeSessionId: 'coordinator', subagent: false, toolCallId: 'live-only-tool',
    }, source.id);
    await historyEntered.promise;
    f.runtime.noteEvent('coordinator', { id: 'live-only-tool-event', type: 'assistant.message',
      data: { interactionId: `interaction:${receipt}`, toolRequests: [{ toolCallId: 'live-only-tool' }] } });
    releaseHistory.resolve();
    assert.equal((await authorization).messageId, source.id);
    assert.deepEqual(f.errors, []);
  } finally { releaseHistory.resolve(); await f.runtime.settled(); f.close(); }
});

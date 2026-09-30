import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AskRequest, McpInvocationMeta } from '@waksana/cockpit-module-sdk/backend';
import { fixture, topic, toolIdentity, deferred } from './fixtures.ts';
import { roleScope } from '../src/topic-session.ts';
import { presentationTextHash } from '../src/service.ts';
import { fingerprint } from '../src/database.ts';
import { questionIdentity } from '../src/question.ts';
import { timeline } from '../src/ui.ts';

type Fixture = ReturnType<typeof fixture>;
async function ask(f: Fixture, request: AskRequest) {
  topic(f);
  f.metas.get('s1')!.ask = request;
  await f.runtime.observe('s1');
  return f.db.records('inbox').find(item => item.kind === 'ask')!;
}
async function dispatch(f: Fixture, text: string, prompt: string, requestId: string = randomUUID()) {
  const input = await f.runtime.acceptReady({ requestId, text });
  await f.runtime.dispatch(toolIdentity(f, input.message.id), { items: [{ topicId: 'topic', prompt }] });
  return input;
}
function organizer(f: Fixture) {
  const role = { moduleId: 'assistant', roleId: 'organizer', moduleName: 'Assistant', name: 'Organizer' };
  f.metas.set('organizer', { ...structuredClone(f.metas.get('s1')!), sessionId: 'organizer',
    roles: [role], appliedRoles: [role], toolScope: roleScope('organizer') });
}
function organizerTool(f: Fixture, receipt: string, toolCallId: string): McpInvocationMeta {
  const events = f.history.get('organizer') ?? [];
  events.push({ id: `org-tool:${toolCallId}`, type: 'assistant.message',
    data: { interactionId: `interaction:${receipt}`, toolRequests: [{ toolCallId, name: 'assistant_topic' }] } });
  f.history.set('organizer', events);
  return { sessionId: 'organizer', runtimeSessionId: 'organizer', subagent: false, toolCallId };
}
async function results(f: Fixture) {
  topic(f);
  f.metas.get('coordinator')!.status = 'running';
  for (const id of ['one', 'two']) await f.event('s1', { id, type: 'assistant.message',
    data: { messageId: id, content: `Worker ${id}`, attachments: [{ type: 'file', path: `/synthetic/${id}` }] } });
  f.metas.get('coordinator')!.status = 'idle'; await f.runtime.wake('coordinator');
  const notice = f.db.records('foreground_inputs').find(root => root.kind === 'notification')!;
  const root = await f.runtime.authorize(toolIdentity(f, '', 'read-results', notice.receipt!));
  f.service.readInbox(notice.inboxIds, root);
  return { root, ids: notice.inboxIds, receipt: notice.receipt! };
}
async function final(f: Fixture, interactionId: string, text: string, id: string) {
  await f.event('coordinator', { id, type: 'assistant.message', data: { messageId: id, interactionId, content: text } });
}

for (const text of [
  'Do not choose Alpha. Explain the options first.',
  'The worker said "Alpha". Explain the options first.',
]) test(`constrained ask never turns negation/quotation into a choice: ${text}`, async () => {
  const f = fixture();
  try {
    const question = await ask(f, { requestId: 'choice', question: 'Which account?', choices: ['Alpha', 'Beta'], allowFreeform: false });
    const input = await dispatch(f, text, 'Alpha');
    assert.equal(f.db.topicMessages(input.message.id)[0]!.state, 'rejected');
    assert.match(f.db.must('messages', input.message.id).diagnostic!, /entire genuine human text/);
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
    assert.equal(f.db.record('inbox', question.id)!.askState, 'pending');
    assert.equal(f.db.record('inbox', question.id)!.body, 'Which account?');
    // Even an exact copy of the full negated/quoted sentence is not an offered option.
    const exact = await dispatch(f, text, text);
    assert.equal(f.db.topicMessages(exact.message.id)[0]!.state, 'rejected');
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
  } finally { f.close(); }
});
test('freeform account invention is refused and the original exact whole human answer is the only response source', async () => {
  const f = fixture();
  try {
    const request = { requestId: 'freeform', question: 'Which account should I use?' };
    const question = await ask(f, request);
    const text = 'I have not selected any account. Explain the options first.';
    const bad = await dispatch(f, text, 'account-production');
    assert.equal(f.db.topicMessages(bad.message.id)[0]!.state, 'rejected');
    assert.equal(f.db.record('inbox', question.id)!.askState, 'pending');
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
    const good = await dispatch(f, ' \nUse account-staging for this request.\n ', 'Use account-staging for this request.');
    const sent = f.calls.find(call => call.name === 'respondAsk')!;
    assert.deepEqual(sent.body, { sessionId: 's1', requestId: 'freeform',
      answer: 'Use account-staging for this request.', wasFreeform: true });
    const binding = f.db.record('foreground_inputs', good.message.id)!.askBinding!;
    assert.equal(binding.messageId, good.message.id);
    assert.equal(binding.requestId, request.requestId);
    assert.equal(binding.questionHash, fingerprint(questionIdentity(request)));
    assert.equal(binding.inboxId, question.id);
  } finally { f.close(); }
});
test('a complete exact human choice succeeds, but mixed ask/business dispatch sends neither answers nor business', async () => {
  const f = fixture();
  try {
    await ask(f, { requestId: 'choice', question: 'Choose', choices: ['Alpha'], allowFreeform: false });
    topic(f, 'business', 's2');
    const mixed = await f.runtime.acceptReady({ requestId: 'mixed', text: 'Alpha and do more research' });
    await f.runtime.dispatch(toolIdentity(f, mixed.message.id), { items: [
      { topicId: 'topic', prompt: 'Alpha' }, { topicId: 'business', prompt: 'Do more research' },
    ] });
    assert.deepEqual(f.db.topicMessages(mixed.message.id).map(row => row.state), ['rejected', 'rejected']);
    assert.match(f.db.must('messages', mixed.message.id).diagnostic!, /separate single-topic/);
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
    assert.equal(f.calls.some(call => call.name === 'prompt' && (call.body as { sessionId: string }).sessionId === 's2'), false);
    const good = await dispatch(f, ' \nAlpha\n ', ' Alpha ');
    assert.equal(f.db.topicMessages(good.message.id)[0]!.state, 'accepted');
    assert.deepEqual(f.calls.find(call => call.name === 'respondAsk')!.body,
      { sessionId: 's1', requestId: 'choice', answer: 'Alpha', wasFreeform: false });
  } finally { f.close(); }
});
test('frozen native request/hash changes reject without answering a different question or substituting a prompt', async () => {
  const f = fixture();
  try {
    const request = { requestId: 'original-request', question: 'Which account?' };
    await ask(f, request);
    let gets = 0;
    f.onGet(async sessionId => {
      if (sessionId === 's1' && ++gets === 2)
        f.metas.get('s1')!.ask = { requestId: 'replacement-request', question: request.question };
    });
    const input = await dispatch(f, 'Use staging', 'Use staging');
    assert.equal(f.db.topicMessages(input.message.id)[0]!.state, 'rejected');
    assert.equal(f.db.record('foreground_inputs', input.message.id)!.askBinding!.requestId, request.requestId);
    assert.equal(f.calls.some(call => call.name === 'respondAsk'), false);
    assert.equal(f.calls.some(call => call.name === 'prompt' && (call.body as { sessionId: string }).sessionId === 's1'), false);
  } finally { f.close(); }
});
test('uncertain exact human ask call is frozen and never retried or consumed automatically', async () => {
  const f = fixture();
  try {
    const question = await ask(f, { requestId: 'unknown-answer', question: 'Which account?' });
    f.fail('respondAsk', new Error('Native acknowledgement lost'));
    const input = await dispatch(f, 'Use staging', 'Use staging', 'one-real-answer');
    assert.equal(f.db.topicMessages(input.message.id)[0]!.state, 'unknown');
    await f.runtime.dispatch(toolIdentity(f, input.message.id), { items: [{ topicId: 'topic', prompt: 'Use staging' }] });
    await f.runtime.start();
    assert.equal(f.calls.filter(call => call.name === 'respondAsk').length, 1);
    assert.equal(f.db.record('inbox', question.id)!.body, 'Which account?');
  } finally { f.close(); }
});
test('reading two results followed by unrelated registry prose consumes neither body nor attachment', async () => {
  const f = fixture();
  try {
    const { root, ids } = await results(f);
    await final(f, root.interactionId!, 'There is one topic.', 'unrelated-registry');
    for (const id of ids) {
      const item = f.db.record('inbox', id)!;
      assert.ok(item.body); assert.equal(item.attachments!.length, 1); assert.equal(item.presented, null);
    }
  } finally { f.close(); }
});
test('an unrelated reply cannot delete a previously read exact native question', async () => {
  const f = fixture();
  try {
    await ask(f, { requestId: 'pending-question', question: 'Choose account', choices: ['Alpha'], allowFreeform: false });
    await f.runtime.wake();
    const notice = f.db.records('foreground_inputs').find(root => root.kind === 'notification')!;
    const root = await f.runtime.authorize(toolIdentity(f, '', 'read-question', notice.receipt!));
    f.service.readInbox(notice.inboxIds, root);
    await final(f, root.interactionId!, 'There is one topic.', 'unrelated-to-question');
    const question = f.db.record('inbox', notice.inboxIds[0]!)!;
    assert.equal(question.body, 'Choose account');
    assert.equal(question.question!.requestId, 'pending-question');
    assert.equal(question.presented, null);
  } finally { f.close(); }
});
test('presentation binds only declared IDs to the exact full persistent response; read/claim itself is not a bubble', async () => {
  const f = fixture();
  try {
    const { root, ids, receipt } = await results(f);
    const text = 'The first worker reported Worker one; no conclusion about the other result.';
    const identity = toolIdentity(f, '', 'one-id-claim', receipt);
    const claim = await f.runtime.presentation(identity, { ids: [ids[0]!], text });
    assert.deepEqual(claim, await f.runtime.presentation(identity, { ids: [ids[0]!], text }));
    assert.equal(f.db.record('inbox', ids[0]!)!.presentations!.length, 1);
    assert.equal(timeline(f.service, undefined, undefined, 50).items.length, 0);
    await final(f, root.interactionId!, 'There is one topic.', 'claim-unrelated-reply');
    assert.ok(f.db.record('inbox', ids[0]!)!.body);
    await final(f, root.interactionId!, text, 'matching-first-presentation');
    const first = f.db.record('inbox', ids[0]!)!, second = f.db.record('inbox', ids[1]!)!;
    assert.equal(first.body, null); assert.equal(first.attachments, null);
    assert.equal(first.presented!.responseId, 'matching-first-presentation');
    assert.equal(second.body, 'Worker two'); assert.equal(second.attachments!.length, 1); assert.equal(second.presented, null);
    const persisted = JSON.stringify(first.presentations);
    assert.equal(persisted.includes(text), false); assert.equal(persisted.includes(presentationTextHash(text)), true);
    await assert.rejects(f.runtime.presentation(identity, { ids: [ids[0]!], text: 'Changed declaration' }),
      { code: 'IDEMPOTENCY_CONFLICT' });
    await f.event('s1', { id: 'one', type: 'assistant.message', data: { messageId: 'one', content: 'Worker one',
      attachments: [{ type: 'file', path: '/synthetic/one' }] } });
    assert.equal(f.db.record('inbox', ids[0]!)!.body, null);
  } finally { f.close(); }
});
test('declaration requires an actual read in this interaction and rejects another interaction even for the same text', async () => {
  const f = fixture();
  try {
    const { ids, root, receipt } = await results(f);
    const input = await f.runtime.acceptReady({ requestId: 'different-root', text: 'Read registry only' });
    const otherIdentity = toolIdentity(f, input.message.id, 'other-declaration');
    await assert.rejects(f.runtime.presentation(otherIdentity, { ids, text: 'Claim without reading' }),
      { code: 'PRESENTATION_UNREAD' });
    const text = 'The worker reported Worker one.';
    await f.runtime.presentation(toolIdentity(f, '', 'same-root-claim', receipt), { ids: [ids[0]!], text });
    const other = await f.runtime.authorize(otherIdentity);
    await final(f, other.interactionId!, text, 'other-root-reply');
    assert.ok(f.db.record('inbox', ids[0]!)!.body);
    await final(f, root.interactionId!, text, 'correct-root-reply');
    assert.equal(f.db.record('inbox', ids[0]!)!.body, null);
  } finally { f.close(); }
});
test('old/duplicate output, ephemeral/tool prelude, partial text and abort cannot satisfy a declaration', async () => {
  const f = fixture();
  try {
    const { ids, root, receipt } = await results(f), text = 'Worker one\nWorker two';
    await final(f, root.interactionId!, text, 'before-declaration');
    await f.runtime.presentation(toolIdentity(f, '', 'late-declaration', receipt), { ids, text });
    await final(f, root.interactionId!, text, 'before-declaration');
    await f.event('coordinator', { id: 'ephemeral-claimed-text', type: 'assistant.message', ephemeral: true,
      data: { interactionId: root.interactionId, content: text } });
    await f.event('coordinator', { id: 'tool-claimed-text', type: 'assistant.message',
      data: { interactionId: root.interactionId, content: text, toolRequests: [{ toolCallId: 'prelude' }] } });
    await final(f, root.interactionId!, 'Worker one', 'partial-claimed-text');
    for (const id of ids) assert.ok(f.db.record('inbox', id)!.body);
    await f.event('coordinator', { id: 'abort-claimed', type: 'abort', data: { interactionId: root.interactionId } });
    await assert.rejects(f.runtime.presentation(toolIdentity(f, '', 'forbidden-after-abort', receipt), { ids, text }),
      { code: 'PRESENTATION_ABORTED' });
    await final(f, root.interactionId!, text, 'after-abort-exact-text');
    for (const id of ids) {
      assert.ok(f.db.record('inbox', id)!.body);
      assert.equal(f.db.record('inbox', id)!.presentations![0]!.state, 'cancelled');
    }
  } finally { f.close(); }
});
test('claim normalization changes only line endings and outer whitespace, never partial prose or internal spaces', async () => {
  const f = fixture();
  try {
    const { root, ids, receipt } = await results(f);
    await f.runtime.presentation(toolIdentity(f, '', 'normalized-claim', receipt), { ids, text: ' \r\nWorker one\r\n  Worker two\r\n ' });
    await final(f, root.interactionId!, 'Worker one\n Worker two', 'wrong-internal-space');
    assert.ok(f.db.record('inbox', ids[0]!)!.body);
    await final(f, root.interactionId!, '\rWorker one\r  Worker two\r', 'normalized-matching');
    for (const id of ids) assert.equal(f.db.record('inbox', id)!.body, null);
  } finally { f.close(); }
});
test('crash/restart preserves body and cancels an unconfirmed declaration without reissuing its tool receipt', async () => {
  const directory = join(process.cwd(), 'node_modules/.cache', `presentation-restart-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  let f = fixture(join(directory, 'test.sqlite'));
  try {
    const { root, ids, receipt } = await results(f), text = 'Worker one and Worker two';
    const identity = toolIdentity(f, '', 'pre-crash-claim', receipt);
    const claimed = await f.runtime.presentation(identity, { ids, text });
    const history = structuredClone(f.history.get('coordinator')!);
    f.close(); f = fixture(join(directory, 'test.sqlite')); f.history.set('coordinator', history);
    await f.runtime.start();
    assert.deepEqual(await f.runtime.presentation(identity, { ids, text }), claimed);
    await final(f, root.interactionId!, text, 'after-restart-reply');
    for (const id of ids) assert.ok(f.db.record('inbox', id)!.body);
    await f.runtime.presentation(toolIdentity(f, '', 'fresh-post-crash-claim', receipt), { ids, text });
    await final(f, root.interactionId!, text, 'fresh-post-crash-output');
    for (const id of ids) assert.equal(f.db.record('inbox', id)!.body, null);
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
  } finally { f.close(); rmSync(directory, { recursive: true }); }
});
test('natural reply and per-ID presentation evidence/body clearing commit atomically', async () => {
  const f = fixture();
  try {
    const { root, ids, receipt } = await results(f), text = 'Present Worker one';
    await f.runtime.presentation(toolIdentity(f, '', 'atomic-claim', receipt), { ids: [ids[0]!], text });
    f.db.sql.exec("CREATE TRIGGER fail_inbox_update BEFORE UPDATE ON inbox BEGIN SELECT RAISE(ABORT,'forced_inbox_failure'); END");
    const event = { id: 'atomic-output', type: 'assistant.message',
      data: { messageId: 'atomic-output', interactionId: root.interactionId, content: text } };
    await assert.rejects(f.runtime.observe('coordinator', event), /forced_inbox_failure/);
    assert.equal(f.db.nativeMessage('coordinator', 'atomic-output'), undefined);
    assert.ok(f.db.record('inbox', ids[0]!)!.body);
    f.db.sql.exec('DROP TRIGGER fail_inbox_update');
    await f.runtime.observe('coordinator', event);
    assert.equal(f.db.record('inbox', ids[0]!)!.body, null);
    assert.ok(f.db.nativeMessage('coordinator', 'atomic-output'));
  } finally { f.close(); }
});
test('organizer cannot read/register/update managed workers outside this kickoff selected IDs', async () => {
  const f = fixture();
  try {
    organizer(f); topic(f, 'selected', 's1'); topic(f, 'not-selected', 's2');
    const root = (await f.runtime.organizerInput('organizer', {
      requestId: 'selected-only', text: 'Organize only selected s1', historySessionIds: ['s1'],
    }))!;
    const identity = organizerTool(f, root.receipt!, 'scoped-organizer');
    const authorized = await f.runtime.authorize(identity);
    assert.equal((await f.runtime.history(authorized, 's1')).sessionId, 's1');
    const reads = f.calls.filter(call => call.name === 'session/chat').length;
    assert.equal(f.service.managed('s2'), true);
    await assert.rejects(f.runtime.history(authorized, 's2'), { code: 'HISTORY_SCOPE' });
    assert.equal(f.calls.filter(call => call.name === 'session/chat').length, reads);
    await assert.rejects(f.runtime.topic(identity, { title: 'Adopt s2', sessionId: 's2' }), { code: 'ORGANIZER_SCOPE' });
    await assert.rejects(f.runtime.topic(identity, { topicId: 'not-selected', content: 'Edit s2' }), { code: 'ORGANIZER_SCOPE' });
    await assert.rejects(f.runtime.topic(identity, { topicId: 'not-selected', sessionId: null }), { code: 'ORGANIZER_SCOPE' });
    await f.runtime.topic(identity, { title: 'Chosen history registration', sessionId: 's1' });
    assert.equal(f.db.must('topics', 'not-selected').content, 'Synthetic topic');
    const human = await f.runtime.acceptReady({ requestId: 'fore-worker-history', text: 'Read registered workers' });
    const front = await f.runtime.authorize(toolIdentity(f, human.message.id));
    assert.equal((await f.runtime.history(front, 's2')).sessionId, 's2');
  } finally { f.close(); }
});
test('concurrent organizer duplicate requests recheck after async validation and send only one frozen original', async () => {
  const f = fixture(), validation = deferred(), both = deferred(), prompted = deferred(), finishPrompt = deferred();
  try {
    organizer(f);
    let gets = 0;
    f.onGet(async sessionId => {
      if (sessionId === 'organizer' && ++gets <= 2) {
        if (gets === 2) both.resolve();
        await validation.promise;
      }
    });
    f.onPrompt(async sessionId => { if (sessionId === 'organizer') { prompted.resolve(); await finishPrompt.promise; } });
    const input = { requestId: 'concurrent', text: 'Selected original only', historySessionIds: ['s1'] };
    const first = f.runtime.organizerInput('organizer', input), second = f.runtime.organizerInput('organizer', input);
    await both.promise; validation.resolve(); await prompted.promise;
    const stored = f.db.records('foreground_inputs')[0]!;
    assert.equal(stored.state, 'calling');
    const again = (await f.runtime.organizerInput('organizer', input))!;
    assert.equal(again.state, 'calling'); assert.equal(again.id, stored.id);
    finishPrompt.resolve();
    const receipts = await Promise.all([first, second]);
    assert.equal(receipts[0]!.id, receipts[1]!.id);
    const accepted = f.db.record('foreground_inputs', stored.id)!;
    assert.equal(accepted.state, 'accepted'); assert.equal(accepted.receipt, 'receipt-1');
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.history.get('organizer')!.filter(event => event.type === 'user.message').length, 1);
    assert.equal((await f.runtime.organizerInput('organizer', input))!.receipt, accepted.receipt);
    await assert.rejects(f.runtime.organizerInput('organizer', { ...input, text: 'Changed original' }),
      { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.db.record('foreground_inputs', stored.id)!.text, input.text);
  } finally { validation.resolve(); finishPrompt.resolve(); f.close(); }
});
test('unknown organizer send receipt is not overwritten or retried by a duplicate kickoff', async () => {
  const f = fixture();
  try {
    organizer(f); f.promptResult('organizer', { ok: true });
    const input = { requestId: 'unknown', text: 'Original', historySessionIds: ['s1'] };
    const root = (await f.runtime.organizerInput('organizer', input))!;
    assert.equal(root.state, 'unknown');
    assert.deepEqual(await f.runtime.organizerInput('organizer', input), root);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  } finally { f.close(); }
});
test('concurrent conflicting organizer content cannot replace the first original after validation awaits', async () => {
  const f = fixture(), validation = deferred(), both = deferred();
  try {
    organizer(f); let gets = 0;
    f.onGet(async sessionId => {
      if (sessionId === 'organizer' && ++gets <= 2) {
        if (gets === 2) both.resolve();
        await validation.promise;
      }
    });
    const original = { requestId: 'same-request', text: 'First immutable source', historySessionIds: ['s1'] };
    const first = f.runtime.organizerInput('organizer', original);
    const changed = f.runtime.organizerInput('organizer', { ...original, text: 'Second conflicting source' });
    const outcomes = Promise.allSettled([first, changed]);
    await both.promise; validation.resolve();
    const [accepted, rejected] = await outcomes;
    assert.equal(accepted!.status, 'fulfilled'); assert.equal(rejected!.status, 'rejected');
    if (rejected!.status === 'rejected') assert.equal(rejected.reason.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(f.db.records('foreground_inputs')[0]!.text, original.text);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  } finally { validation.resolve(); f.close(); }
});

for (const answering of [false, true]) test(`late read authorization preserves a frozen ${answering ? 'ask' : 'business'} dispatch`, async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    if (answering) await ask(f, { requestId: 'frozen-ask', question: 'Which account?' });
    else topic(f);
    topic(f, 'other', 's2');
    const input = await f.runtime.acceptReady({ requestId: 'one-input', text: 'Use staging' });
    let reads = 0;
    f.onGet(async sessionId => {
      if (sessionId === 'coordinator' && ++reads === 2) { entered.resolve(); await release.promise; }
    });
    const reading = f.runtime.authorize(toolIdentity(f, input.message.id, 'slow-read'));
    await entered.promise; f.onGet(null);
    await f.runtime.dispatch(toolIdentity(f, input.message.id, 'first-dispatch'), {
      items: [{ topicId: 'topic', prompt: 'Use staging' }],
    });
    const frozen = f.db.record('foreground_inputs', input.message.id)!;
    assert.ok(frozen.dispatchHash);
    if (answering) assert.equal(frozen.askBinding!.requestId, 'frozen-ask');
    release.resolve();
    const current = await reading;
    assert.equal(current.dispatchHash, frozen.dispatchHash);
    assert.deepEqual(current.askBinding, frozen.askBinding);
    assert.equal(f.db.record('foreground_inputs', input.message.id)!.dispatchHash, frozen.dispatchHash);
    await assert.rejects(f.runtime.dispatch(toolIdentity(f, input.message.id, 'second-dispatch'), {
      items: [{ topicId: 'other', prompt: 'Unwanted additional business' }],
    }), { code: 'FROZEN_DISPATCH' });
    assert.equal(f.db.topicMessages(input.message.id).length, 1);
    assert.equal(f.db.topicMessages(input.message.id)[0]!.state, 'accepted');
    assert.equal(f.calls.some(call => call.name === 'prompt'
      && (call.body as { sessionId: string }).sessionId === 's2'), false);
    if (answering) assert.equal(f.calls.filter(call => call.name === 'respondAsk').length, 1);
  } finally { release.resolve(); f.close(); }
});

test('authorization awaiting readiness cannot erase a primary abort or let its late reply consume results', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const { root, ids, receipt } = await results(f), text = 'Worker one and Worker two';
    let reads = 0;
    f.onGet(async sessionId => {
      if (sessionId === 'coordinator' && ++reads === 2) { entered.resolve(); await release.promise; }
    });
    const claiming = f.runtime.presentation(toolIdentity(f, '', 'slow-claim', receipt), { ids, text });
    const rejected = assert.rejects(claiming, { code: 'PRESENTATION_ABORTED' });
    await entered.promise; f.onGet(null);
    await f.event('coordinator', { id: 'abort-during-authorization', type: 'abort',
      data: { interactionId: root.interactionId } });
    assert.equal(f.db.record('foreground_inputs', root.id)!.presentationAborted, true);
    release.resolve(); await rejected;
    assert.equal(f.db.record('foreground_inputs', root.id)!.presentationAborted, true);
    await final(f, root.interactionId!, text, 'late-after-authorization');
    for (const id of ids) {
      assert.ok(f.db.record('inbox', id)!.body);
      assert.equal(f.db.record('inbox', id)!.presented, null);
    }
  } finally { release.resolve(); f.close(); }
});

test('authorization rejects a receipt changed while readiness was being checked', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const input = await f.runtime.acceptReady({ requestId: 'changed-receipt', text: 'Inspect register' });
    let reads = 0;
    f.onGet(async sessionId => {
      if (sessionId === 'coordinator' && ++reads === 2) { entered.resolve(); await release.promise; }
    });
    const reading = f.runtime.authorize(toolIdentity(f, input.message.id, 'receipt-race'));
    const rejected = assert.rejects(reading, { code: 'TOOL_PROVENANCE' });
    await entered.promise;
    const changed = f.db.record('foreground_inputs', input.message.id)!;
    changed.receipt = 'different-native-receipt';
    f.db.save('foreground_inputs', changed);
    release.resolve(); await rejected;
    assert.equal(f.db.record('foreground_inputs', input.message.id)!.receipt, 'different-native-receipt');
  } finally { release.resolve(); f.close(); }
});

test('organizer cannot overwrite a foreground remapping committed during target validation', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    organizer(f); topic(f);
    const root = (await f.runtime.organizerInput('organizer', {
      requestId: 'only-s1', text: 'Organize selected s1', historySessionIds: ['s1'],
    }))!;
    f.onGet(async sessionId => { if (sessionId === 's1') { entered.resolve(); await release.promise; } });
    const editing = f.runtime.topic(organizerTool(f, root.receipt!, 'old-mapping-edit'), {
      topicId: 'topic', title: 'Old organizer title', sessionId: 's1',
    });
    const rejected = assert.rejects(editing, { code: 'ORGANIZER_SCOPE' });
    await entered.promise; f.onGet(null);
    const human = await f.runtime.acceptReady({ requestId: 'new-mapping', text: 'Assign the topic to s2' });
    const updated = await f.runtime.topic(toolIdentity(f, human.message.id, 'foreground-remap'), {
      topicId: 'topic', title: 'New foreground mapping', sessionId: 's2',
    });
    release.resolve(); await rejected;
    assert.deepEqual(f.db.must('topics', 'topic'), updated);
    assert.equal(updated.sessionId, 's2');
    assert.equal(f.db.record('workers', 's1'), undefined);
  } finally { release.resolve(); f.close(); }
});

for (const presented of [false, true]) test(`notification readiness cannot undo a concurrent ${presented ? 'presentation' : 'read'}`, async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    topic(f);
    const input = await f.runtime.acceptReady({ requestId: 'active-reader', text: 'Inspect results' });
    const reader = await f.runtime.authorize(toolIdentity(f, input.message.id, 'before-notice-read'));
    await f.runtime.observe('coordinator');
    await f.runtime.observe('s1', { id: 'pending-notice', type: 'assistant.message',
      data: { messageId: 'pending-notice', content: 'Actual worker result' } });
    const item = f.db.records('inbox')[0]!;
    f.onGet(async sessionId => { if (sessionId === 'coordinator') { entered.resolve(); await release.promise; } });
    const notifying = f.runtime.wake();
    await entered.promise; f.onGet(null);
    f.service.readInbox([item.id], reader);
    if (presented) {
      f.service.declarePresentation({ ids: [item.id], text: 'The worker reported a result.' }, reader, 'notice-race-claim');
      await f.runtime.observe('coordinator', { id: 'notice-race-response', type: 'assistant.message',
        data: { messageId: 'notice-race-response', interactionId: reader.interactionId,
          content: 'The worker reported a result.' } });
    }
    const observed = f.db.record('inbox', item.id)!;
    release.resolve(); await notifying;
    assert.deepEqual(f.db.record('inbox', item.id), observed);
    assert.equal(f.db.records('foreground_inputs').filter(root => root.kind === 'notification').length, 0);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  } finally { release.resolve(); f.close(); }
});

test('an in-flight native answer never restores a question body concurrently presented', async t => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const question = await ask(f, { requestId: 'answer-in-flight', question: 'Choose an account', choices: ['Alpha'], allowFreeform: false });
    const display = await f.runtime.acceptReady({ requestId: 'display-question', text: 'Show the question' });
    const reader = await f.runtime.authorize(toolIdentity(f, display.message.id, 'read-before-answer'));
    f.service.readInbox([question.id], reader);
    f.service.declarePresentation({ ids: [question.id], text: question.body! }, reader, 'present-before-answer-ack');
    const originalAnswer = f.native.answer.bind(f.native);
    t.mock.method(f.native, 'answer', async (...args: Parameters<typeof originalAnswer>) => {
      entered.resolve(); await release.promise; return originalAnswer(...args);
    });
    const input = await f.runtime.acceptReady({ requestId: 'answer-question', text: 'Alpha' });
    const answering = f.runtime.dispatch(toolIdentity(f, input.message.id, 'delayed-native-answer'), {
      items: [{ topicId: 'topic', prompt: 'Alpha' }],
    });
    await entered.promise;
    await f.runtime.observe('coordinator', { id: 'question-visible', type: 'assistant.message',
      data: { messageId: 'question-visible', interactionId: reader.interactionId, content: question.body! } });
    const presented = f.db.record('inbox', question.id)!;
    assert.equal(presented.body, null);
    release.resolve(); await answering;
    const current = f.db.record('inbox', question.id)!;
    assert.equal(current.askState, 'answered');
    assert.equal(current.body, null); assert.equal(current.question, null);
    assert.deepEqual(current.presented, presented.presented);
    assert.deepEqual(current.presentations, presented.presentations);
  } finally { release.resolve(); f.close(); }
});

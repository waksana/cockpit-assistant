import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody, ModuleHostIntentResult,
  NativeChatEvent, PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { Evidence, readInput, resolveInput } from '../src/evidence.ts';
import type { Caller, Gateway } from '../src/gateway.ts';
import { Store } from '../src/store.ts';

const event = (id: string, content = id, type = 'assistant.message'): NativeChatEvent =>
  ({ id, type, timestamp: 10, data: { messageId: `message-${id}`, content } });
const decisionEvent = (toolCallId = 'read-1'): NativeChatEvent => ({
  id: `decision-${toolCallId}`, type: 'assistant.message',
  data: { interactionId: 'interaction', toolRequests: [{ toolCallId }] },
});
function fixture() {
  const store = new Store(':memory:');
  store.saveTopic({ id: 'topic', title: 'Owner', content: 'Legacy: not released', archived: false, version: 1,
    session_id: 'source', mapping_state: 'bound', mapping_error: null, creation_receipt: null });
  const events = new Map<string, NativeChatEvent[]>([['source', []], ['front', []]]);
  const calls: { name: string; body: unknown }[] = [];
  const caller: Caller = { sessionId: 'front', role: 'coordinator', toolCallId: 'read-1',
    input: { sessionId: 'front', messageId: 'human', interactionId: 'interaction', human: false,
      text: 'Location-only update', attachments: [], createdAt: 100 } };
  let expired = false, stopped = false, missing = false;
  const host: ModuleHostApi = {
    async call<N extends ModuleHostIntent>(name: N, body: ModuleHostIntentBody<N>): Promise<ModuleHostIntentResult<N>> {
      assert.equal(name, 'session/chat');
      calls.push({ name, body });
      const query = body as ModuleHostIntentBody<'session/chat'>;
      assert.equal(query.source, 'persisted'); assert.equal(query.direction, 'backward');
      const all = events.get(query.sessionId) ?? [], end = query.cursor ? Number(query.cursor.slice(7)) : all.length;
      const start = Math.max(0, end - query.max);
      return { sessionId: query.sessionId, source: 'persisted', direction: 'backward',
        events: all.slice(start, end), cursor: `before:${start}`, hasMore: start > 0,
        cursorStatus: expired ? 'expired' : 'ok', read: { rpc: 1, events: end - start } } as ModuleHostIntentResult<N>;
    },
  };
  const native: Gateway = {
    host, caller: async () => caller,
    session: async id => missing ? null : ({ sessionId: id, loaded: false, status: 'idle', roles: [],
      appliedRoles: [], ask: null, cwd: '/synthetic', title: id, lastActivity: 0 } satisfies PublicSessionMeta),
    foreground: async () => null, validateForeground: async () => {}, observe() {},
  };
  const evidence = new Evidence(store, native, () => stopped);
  return { store, events, calls, caller, native, evidence,
    expired(value: boolean) { expired = value; }, stop() { stopped = true; },
    missing() { missing = true; },
    async token() { const check = await evidence.check('source', 'front'); assert.ok(check.readToken); return check.readToken; },
    read(token: string, extra = {}) { return evidence.read(caller, readInput.parse({ token, ...extra })); },
    resolve(receiptId: string, disposition: 'silent' | 'notify') {
      return evidence.resolve(caller, resolveInput.parse({ receiptId, disposition }));
    },
    incoming(item: NativeChatEvent) {
      store.enqueue({ session_id: 'source', native_id: String(item.data.messageId), kind: 'reply',
        text: String(item.data.content), attachments: [], question: null }, 'pending',
      { eventId: item.id, timestamp: item.timestamp ?? null });
    },
    close() { store.close(); },
  };
}
type ReadResult = Awaited<ReturnType<Evidence['read']>>;
function read(result: ReadResult) {
  assert.equal(result.status, 'read'); assert.ok('receipt' in result && result.receipt);
  return result;
}

test('native tail checks are bounded, are not reads, and legacy topic text never substitutes for Chat', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('released', 'Released now')]);
    const check = await f.evidence.check('source', 'front');
    assert.equal(check.changed, true); assert.equal(check.evidenceInThisResponse, false);
    assert.equal(check.lastRead, null);
    assert.deepEqual(f.calls.map(call => (call.body as { max: number }).max), [1]);
    const result = read(await f.read(check.readToken!));
    assert.ok('events' in result); assert.match(JSON.stringify(result.events), /Released now/);
    assert.doesNotMatch(JSON.stringify(result), /Legacy/);
    assert.equal(result.receipt.disposition, 'unresolved');
    assert.equal((await f.evidence.check('source', 'front')).changed, false);
  } finally { f.close(); }
});

test('unchanged sources can recover actual evidence after context loss or a new service instance', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('result')]);
    const first = read(await f.read(await f.token()));
    await f.resolve(first.receipt.id, 'silent');
    const restarted = new Evidence(f.store, f.native, () => false);
    const check = await restarted.check('source', 'front');
    assert.equal(check.changed, false);
    const recovered = read(await restarted.read(f.caller, readInput.parse({ token: check.readToken, recover: true })));
    assert.deepEqual(recovered.receipt.eventIds, ['result']);
    assert.equal(recovered.priorDispositions[0]?.disposition, 'silent');
  } finally { f.close(); }
});

test('incremental paging does not advance a checkpoint past an unread gap', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('base')]);
    read(await f.read(await f.token()));
    f.events.get('source')!.push(...Array.from({ length: 20 }, (_, i) => event(`new-${i}`)));
    const check = await f.evidence.check('source', 'front'), first = read(await f.read(check.readToken!));
    assert.equal(first.complete, false); assert.ok(first.nextToken);
    assert.equal((await f.evidence.check('source', 'front')).lastRead?.eventId, 'base');
    const second = read(await f.read(first.nextToken));
    assert.equal(second.complete, true);
    assert.equal((await f.evidence.check('source', 'front')).lastRead?.eventId, 'new-19');
    assert.deepEqual(second.receipt.eventIds, ['new-0', 'new-1', 'new-2', 'new-3']);
  } finally { f.close(); }
});

test('large messages require consecutive fragments and preserve exact text without a body mirror', async () => {
  const f = fixture();
  try {
    const content = 'huge-message-'.repeat(4000);
    f.events.set('source', [event('huge', content)]);
    const token = await f.token(), first = await f.read(token);
    assert.equal(first.status, 'fragment'); assert.ok('fragment' in first);
    assert.equal(f.evidence.pending('front').length, 0);
    await assert.rejects(f.read(token, { offset: 24000 }), { code: 'READ_OFFSET' });
    assert.equal(typeof first.fragment, 'string');
    let chunks = first.fragment!, offset = first.nextOffset, result: ReadResult = first;
    while (offset !== null && offset !== undefined) {
      result = await f.read(token, { offset });
      assert.ok('fragment' in result && typeof result.fragment === 'string');
      chunks += result.fragment;
      offset = result.nextOffset;
    }
    assert.equal(JSON.parse(chunks!)[0].content, content);
    assert.equal(read(result).receipt.eventIds[0], 'huge');
    assert.doesNotMatch(JSON.stringify(f.store.sql.prepare('SELECT * FROM seen').all()), /huge-message-/);
  } finally { f.close(); }
});

test('expired cursors and changed head ranges do not advance read state or silently mix fragments', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('big', 'x'.repeat(25000))]);
    const token = await f.token();
    assert.equal((await f.read(token)).status, 'fragment');
    f.events.get('source')!.push(event('concurrent'));
    assert.equal((await f.read(token, { offset: 12000 })).status, 'range-changed');
    f.expired(true);
    assert.equal((await f.read(token)).status, 'cursor-expired');
    assert.equal(f.evidence.pending('front').length, 0);
  } finally { f.close(); }
});

test('an old receipt recovers exact native identities through bounded pages after new arrivals', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('original')]);
    const result = read(await f.read(await f.token()));
    f.events.get('source')!.push(...Array.from({ length: 20 }, (_, i) => event(`later-${i}`)));
    let recovery = read(await f.read(result.token, { recover: true }));
    assert.ok(recovery.nextToken); assert.deepEqual(recovery.receipt.eventIds, []);
    recovery = read(await f.read(recovery.nextToken));
    assert.deepEqual(recovery.receipt.eventIds, ['original']);
    assert.equal(recovery.complete, true);
  } finally { f.close(); }
});

test('unloaded and missed-event sources remain readable without loading or dispatch', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('missed', 'Result observed only by query')]);
    const result = read(await f.read(await f.token()));
    assert.deepEqual(result.receipt.eventIds, ['missed']);
    assert.ok(f.calls.every(call => call.name === 'session/chat'));
    assert.equal(result.receipt.disposition, 'unresolved');
  } finally { f.close(); }
});

test('source locations contain no new body copies and resolve only the actually returned range', async () => {
  const f = fixture();
  try {
    const old = event('old', 'Old source body'), later = event('later', 'Concurrent source body');
    f.events.set('source', [old]); f.incoming(old);
    const result = read(await f.read(await f.token()));
    assert.equal(f.store.inbox().length, 1);
    assert.equal(f.store.inbox()[0]?.text, '');
    f.events.get('source')!.push(later); f.incoming(later);
    await f.resolve(result.receipt.id, 'silent');
    assert.deepEqual(f.store.inbox().map(item => item.native_id), ['message-later']);
    f.incoming(old);
    assert.equal(f.store.inbox().length, 1);
    assert.doesNotMatch(JSON.stringify(f.store.sql.prepare('SELECT * FROM seen').all()), /Old source body/);
  } finally { f.close(); }
});

test('notification decisions require actual same-interaction primary output and never authorize sends', async () => {
  const f = fixture();
  try {
    const source = event('final'); f.events.set('source', [source]); f.incoming(source);
    const result = read(await f.read(await f.token()));
    assert.equal((await f.resolve(result.receipt.id, 'notify')).disposition, 'awaiting-output');
    assert.equal(f.store.inbox().length, 0);
    for (const output of [
      { ...event('tool'), data: { content: 'Thinking', interactionId: 'interaction', toolRequests: [{}] } },
      { ...event('wrong'), data: { content: 'Wrong interaction', interactionId: 'other' } },
      { ...event('subagent'), agentId: 'helper', data: { content: 'Helper', interactionId: 'interaction' } },
    ]) await f.evidence.observeForeground('front', output);
    assert.equal(f.evidence.pending('front')[0]?.disposition, 'awaiting-output');
    const output = { ...event('user-facing'),
      data: { content: 'Done', interactionId: 'interaction', messageId: 'output-message' } };
    f.events.set('front', [decisionEvent(), output]);
    await f.evidence.observeForeground('front', output);
    assert.equal(f.evidence.pending('front').length, 0);
    const replay = read(await f.read(result.token));
    assert.equal(replay.priorDispositions[0]?.outputEventId, 'user-facing');
    assert.equal(replay.priorDispositions[0]?.disposition, 'notified');
    assert.ok(f.calls.every(call => call.name === 'session/chat'));
  } finally { f.close(); }
});

test('restarting after a lost output observation reconciles native evidence without replaying the notification', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('source-result')]);
    const result = read(await f.read(await f.token()));
    await f.resolve(result.receipt.id, 'notify');
    f.events.set('front', [decisionEvent(), { ...event('original-output'), data: { content: 'Presented', interactionId: 'interaction' } }]);
    await new Evidence(f.store, f.native, () => false).reconcileOutput('front');
    assert.equal(f.evidence.pending('front').length, 0);
    assert.ok(f.calls.every(call => call.name === 'session/chat'));
  } finally { f.close(); }
});

test('the same native result cannot reserve a second presentation through a different read', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('result')]);
    const first = read(await f.read(await f.token()));
    await f.resolve(first.receipt.id, 'notify');
    const second = read(await f.read(await f.token(), { recover: true }));
    const decision = await f.resolve(second.receipt.id, 'notify');
    assert.ok('alreadyHandled' in decision && decision.alreadyHandled);
    assert.equal(f.evidence.pending('front').filter(row => row.disposition === 'awaiting-output').length, 1);
  } finally { f.close(); }
});

test('unknown wake acceptance remains distinct from read and silent disposition', async () => {
  const f = fixture();
  try {
    const source = event('result'); f.events.set('source', [source]); f.incoming(source);
    const notice = f.store.reserveNotice()!;
    f.store.settleNotice(notice.id, null, false);
    assert.equal(f.store.inbox()[0]?.notice_state, 'unknown');
    assert.equal(f.evidence.pending('front').length, 0);
    const result = read(await f.read(await f.token()));
    assert.equal(f.store.inbox()[0]?.notice_state, 'unknown');
    await f.resolve(result.receipt.id, 'silent');
    assert.equal(f.store.reserveNotice(), null);
  } finally { f.close(); }
});

test('current questions cannot be silently swallowed and arbitrary read/notification claims are rejected', async () => {
  const f = fixture();
  try {
    f.store.enqueue({ session_id: 'source', native_id: 'ask', kind: 'ask', text: 'Decide?',
      attachments: [], question: { requestId: 'ask', question: 'Decide?' } });
    const receipt = f.evidence.question(f.caller, f.store.inbox()[0]!.id, 'ask', 'source');
    await assert.rejects(f.resolve(receipt.id, 'notify'), { code: 'STALE_ASK' });
    f.native.session = async sessionId => ({ sessionId, title: sessionId, cwd: '/synthetic', loaded: true,
      status: 'idle', lastActivity: 0, roles: [], ask: { requestId: 'ask', question: 'Decide?' } });
    await assert.rejects(f.resolve(receipt.id, 'silent'), { code: 'ASK_PRESENTATION' });
    await assert.rejects(f.resolve('made-up', 'notify'), { code: 'READ_RECEIPT' });
    f.caller.sessionId = 'other';
    await assert.rejects(f.resolve(receipt.id, 'notify'), { code: 'READ_RECEIPT' });
  } finally { f.close(); }
});

test('source authorization and stopping are rechecked before evidence reads', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('result')]);
    const token = await f.token();
    f.stop();
    await assert.rejects(f.read(token), { code: 'STOPPING' });
    f.missing();
    await assert.rejects(f.read(token), { code: 'HISTORY_SCOPE' });
  } finally { f.close(); }
});

test('silent resolution handles matching callbacks arriving after the read but preserves different new events', async () => {
  const f = fixture();
  try {
    const source = event('late-callback'), concurrent = event('different-new');
    f.events.set('source', [source]);
    const result = read(await f.read(await f.token()));
    assert.deepEqual(result.receipt.inboxIds, []);
    f.incoming(source); f.incoming(concurrent);
    await f.resolve(result.receipt.id, 'silent');
    assert.deepEqual(f.store.inbox().map(row => row.native_id), ['message-different-new']);
    const afterDecision = event('callback-after-decision');
    f.events.get('source')!.push(afterDecision);
    const next = read(await f.read(await f.token()));
    await f.resolve(next.receipt.id, 'silent');
    f.incoming(afterDecision);
    assert.deepEqual(f.store.inbox().map(row => row.native_id), ['message-different-new']);
  } finally { f.close(); }
});

test('earlier same-interaction commentary cannot be notification evidence for a later decision', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('result')]);
    const commentary = { ...event('commentary'), data: { interactionId: 'interaction', content: 'I will check' } };
    f.events.set('front', [commentary, decisionEvent()]);
    const result = read(await f.read(await f.token()));
    await f.resolve(result.receipt.id, 'notify');
    await f.evidence.reconcileOutput('front');
    await f.evidence.observeForeground('front', commentary);
    assert.equal(f.evidence.pending('front')[0]?.disposition, 'awaiting-output');
    assert.equal(f.evidence.pendingSummary('front').outputRecovery?.evidence, 'unknown');
  } finally { f.close(); }
});

test('empty reads never crowd out actionable decisions and pending decision pages are explicit', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('waiting')]);
    const waiting = read(await f.read(await f.token()));
    await f.resolve(waiting.receipt.id, 'notify');
    for (let index = 0; index < 55; index++) read(await f.read(await f.token()));
    assert.equal(f.evidence.pendingSummary('front').items[0]?.receiptId, waiting.receipt.id);
    for (let index = 0; index < 51; index++) {
      f.events.get('source')!.push(event(`new-${index}`));
      read(await f.read(await f.token()));
    }
    const page = f.evidence.pendingSummary('front');
    assert.equal(page.items.length, 50); assert.equal(page.hasMore, true);
    assert.equal(f.evidence.pendingSummary('front', page.nextAfter).items.length, 2);
    const output = { ...event('final'), data: { interactionId: 'interaction', content: 'Presented' } };
    f.events.set('front', [decisionEvent(), output]);
    await f.evidence.observeForeground('front', output);
    assert.equal(read(await f.read(waiting.token, { recover: true })).receipt.disposition, 'silent');
    assert.ok(!f.evidence.pending('front').some(row => row.id === waiting.receipt.id));
  } finally { f.close(); }
});

test('interrupted location fragments retain exact recovery targets after concurrent arrivals', async () => {
  const f = fixture();
  try {
    const original = event('large-original', 'x'.repeat(25000));
    f.events.set('source', [original]);
    const token = f.evidence.locations('source', 'front', [original.id]);
    assert.equal((await f.read(token)).status, 'fragment');
    f.events.get('source')!.push(...Array.from({ length: 20 }, (_, index) => event(`other-${index}`)));
    assert.equal((await f.read(token, { offset: 12000 })).status, 'range-changed');
    const recovery = read(await f.read(token, { recover: true }));
    assert.equal(recovery.complete, false); assert.ok(recovery.nextToken);
    let part = await f.read(recovery.nextToken);
    assert.equal(part.status, 'fragment');
    while ('nextOffset' in part && typeof part.nextOffset === 'number')
      part = await f.read(recovery.nextToken, { offset: part.nextOffset });
    assert.deepEqual(read(part).receipt.eventIds, ['large-original']);
  } finally { f.close(); }
});

test('a missing previous checkpoint is an explicit gap, not complete incremental coverage', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('removed-by-rewind')]);
    read(await f.read(await f.token()));
    f.events.set('source', [event('replacement')]);
    const result = read(await f.read(await f.token()));
    assert.equal(result.complete, false); assert.equal(result.boundaryMissing, true);
    assert.equal((await f.evidence.check('source', 'front')).lastRead?.eventId, 'removed-by-rewind');
  } finally { f.close(); }
});

test('interrupted status reads retain their original event range and detect changed original bodies', async () => {
  const f = fixture();
  try {
    f.events.set('source', [event('original', 'a'.repeat(24000))]);
    const token = await f.token();
    assert.equal((await f.read(token)).status, 'fragment');
    f.events.get('source')!.push(...Array.from({ length: 20 }, (_, index) => event(`newer-${index}`)));
    const recovery = read(await f.read(token, { recover: true }));
    assert.equal(recovery.complete, false); assert.ok(recovery.nextToken);
    f.events.get('source')![0] = event('original', 'Changed under the same native ID');
    await assert.rejects(f.read(recovery.nextToken), { code: 'NATIVE_EVENT_CHANGED' });
  } finally { f.close(); }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import type { NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { Database, fingerprint } from '../src/database.ts';
import { Ingestion } from '../src/ingestion.ts';
import { AssistantService } from '../src/service.ts';
import { fixture, stageDelivery } from './fixtures.ts';

function root(messageId = 'receipt', interactionId = 'interaction', id = 'root-event'): NativeChatEvent {
  return { id, type: 'user.message', data: { messageId, interactionId, content: 'Native forwarded prompt' } };
}
function reply(id = 'reply-event', content = 'Original response', interactionId = 'interaction'): NativeChatEvent {
  return { id, type: 'assistant.message', data: { messageId: `message:${id}`, interactionId, content } };
}
function replies(f: ReturnType<typeof fixture>) {
  return f.db.find('messages', message => message.kind === 'reply');
}
function conversation(f: ReturnType<typeof fixture>) {
  return Object.fromEntries((['native', 'messages', 'work', 'publications', 'deliveries', 'messageTopics'] as const)
    .map(table => [table, f.db.list(table).items]));
}

test('native receipt matches data.messageId, never event.id or matching prompt text', t => {
  const f = fixture(); t.after(() => f.close());
  const delivery = stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  f.runtime.ingestion.apply('s1', 1, [
    { ...root('ordinary', 'wrong', 'receipt'), data: {
      messageId: 'ordinary', interactionId: 'wrong', content: delivery.text,
    } },
    reply('wrong-reply', 'Not an Assistant response', 'wrong'),
  ], 'unrelated');
  assert.equal(replies(f)[0]?.deliveryId, undefined);
  assert.equal(replies(f)[0]?.raw, 'Not an Assistant response');
  assert.equal(f.db.must('deliveries', delivery.id).interactionId, undefined);
  const event = reply();
  f.runtime.ingestion.apply('s1', 1, [root(), event], 'linked');
  const message = replies(f)[1]!;
  assert.equal(message.raw, event.data.content);
  assert.equal(message.nativeEventId, event.id);
  assert.equal(message.nativeMessageId, event.data.messageId);
  assert.equal(message.deliveryId, delivery.id);
  assert.equal(message.correlation, 'native');
  assert.equal(f.db.must('deliveries', delivery.id).interactionId, 'interaction');
  assert.equal(f.db.list('native').items.length, 3);
  assert.equal(f.db.get('native', fingerprint(['s1', 'receipt'])), undefined);
  assert.equal(f.db.find('publications', item => item.messageId === message.id && item.type === 'message').length, 1);
  assert.equal(f.db.must('work', `message:${message.id}:1`).state, 'pending');
});

test('all primary message segments are visible immediately, including text accompanying tool requests', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const first = { ...reply('first', '  First explanation\n'),
    data: { ...reply('first', '  First explanation\n').data, toolRequests: [{ id: 'tool', name: 'read', arguments: {} }] } };
  const second = reply('second', 'Follow-up explanation');
  f.runtime.ingestion.apply('s1', 1, [root(), first], 'first-page');
  assert.deepEqual(replies(f).map(message => message.raw), ['  First explanation\n']);
  f.runtime.ingestion.apply('s1', 1, [second], 'second-page');
  assert.deepEqual(replies(f).map(message => message.raw), ['  First explanation\n', 'Follow-up explanation']);
  assert.equal(f.db.find('work', item => item.kind === 'output').length, 2);
  assert.equal(f.db.find('publications', item => item.type === 'message').length, 3);
  assert.deepEqual(f.db.list('native').items.map(item => item.event.type),
    ['user.message', 'assistant.message', 'assistant.message']);
});

test('an attachment-only ordinary reply is visible without a text or interaction field', t => {
  const f = fixture(); t.after(() => f.close());
  const attachments = [{ type: 'blob' as const, mimeType: 'text/plain', data: 'SGVsbG8=' }];
  f.runtime.ingestion.apply('s1', 1, [{ id: 'attachment-only', type: 'assistant.message',
    data: { attachments } }], 'attachment-page');
  assert.equal(replies(f).length, 1);
  assert.equal(replies(f)[0]!.raw, '');
  assert.deepEqual(replies(f)[0]!.attachments, attachments);
  assert.equal(f.db.find('publications', publication => publication.type === 'message').length, 1);
});

test('all ordinary primary replies are inputs for attribution, but native user messages never are', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  f.runtime.ingestion.apply('s1', 1, [root(), reply()], 'assistant-page');
  f.runtime.ingestion.apply('s1', 1, [
    root('ordinary-receipt', 'ordinary-interaction', 'ordinary-root'),
    reply('ordinary-output', 'Private ordinary answer', 'ordinary-interaction'),
    { id: 'missing-identity', type: 'assistant.message', data: { content: 'No interaction identity' } },
    { id: 'missing-receipt', type: 'user.message', data: { content: 'Private user input', interactionId: 'interaction' } },
    reply('empty-identity', 'An empty identity is not provenance', ''),
  ], 'ordinary-page');
  assert.deepEqual(replies(f).map(message => message.raw), [
    'Original response', 'Private ordinary answer', 'No interaction identity', 'An empty identity is not provenance',
  ]);
  assert.equal(f.db.find('messages', message => message.kind === 'user' && message.sessionId !== null).length, 0);
  assert.equal(f.db.find('native', record => record.event.type === 'user.message').length, 1);
  assert.equal(f.db.must('receptions', 's1').cursor, 'ordinary-page');
  assert.equal(f.db.list('questions').items.length, 0);
});

test('receipt identities and response interactions are scoped to their exact ordinary session', t => {
  const f = fixture(); t.after(() => f.close());
  const one = stageDelivery(f, { id: 'one', sessionId: 's1', state: 'accepted', nativeMessageId: 'receipt' });
  const two = stageDelivery(f, { id: 'two', sessionId: 's2', state: 'accepted', nativeMessageId: 'receipt' });
  f.runtime.ingestion.apply('s1', 1, [root('receipt', 'first'), reply('same-event', 'First session', 'first')], 's1-page');
  f.runtime.ingestion.apply('s2', 1, [reply('unrelated', 'Same interaction in another session', 'first')], 'unrelated');
  assert.equal(replies(f).length, 2);
  f.runtime.ingestion.apply('s2', 1, [root('receipt', 'second'), reply('same-event', 'Second session', 'second')], 's2-page');
  assert.deepEqual(replies(f).map(message => [message.sessionId, message.deliveryId, message.raw]),
    [['s1', one.id, 'First session'], ['s2', undefined, 'Same interaction in another session'], ['s2', two.id, 'Second session']]);
  assert.equal(f.db.list('native').items.length, 5);
});

test('unknown, unsent and rejected prompt effects do not establish a receipt association', () => {
  for (const state of ['pending', 'calling', 'unknown', 'rejected', 'cancelled'] as const) {
    const f = fixture();
    try {
      stageDelivery(f, { state, nativeMessageId: 'receipt' });
      f.runtime.ingestion.apply('s1', 1, [root(), reply()], 'ignored');
      assert.equal(replies(f).length, 1, state);
      assert.equal(replies(f)[0]!.deliveryId, undefined, state);
      assert.equal(f.db.must('deliveries', 'delivery').interactionId, undefined, state);
    } finally { f.close(); }
  }
});

test('missing receipt and non-prompt deliveries do not gate ordinary primary replies', () => {
  for (const options of [
    { nativeMessageId: undefined, kind: 'prompt' as const },
    { nativeMessageId: 'receipt', kind: 'wake' as const },
    { nativeMessageId: 'receipt', kind: 'ask' as const },
  ]) {
    const f = fixture();
    try {
      stageDelivery(f, { state: 'accepted', ...options });
      f.runtime.ingestion.apply('s1', 1, [root(), reply()], 'ignored');
      assert.equal(replies(f).length, 1);
      assert.equal(replies(f)[0]!.deliveryId, undefined);
    } finally { f.close(); }
  }
});

test('ephemeral and subagent sources cannot bind receipts or emit Assistant messages', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const variants: Partial<NativeChatEvent>[] = [
    { ephemeral: true }, { agentId: 'helper' }, { parentToolCallId: 'tool-call' },
    { data: { agentId: 'nested-helper' } }, { data: { parentToolCallId: 'nested-tool' } },
  ];
  for (const [index, variant] of variants.entries()) {
    const marked = (event: NativeChatEvent): NativeChatEvent => ({
      ...event, ...variant, id: `${event.id}:${index}`, data: { ...event.data, ...variant.data },
    });
    f.runtime.ingestion.apply('s1', 1, [marked(root()), marked(reply())], `ignored:${index}`);
  }
  assert.equal(f.db.must('deliveries', 'delivery').interactionId, undefined);
  assert.equal(f.db.list('native').items.length, 0);
  f.runtime.ingestion.apply('s1', 1, [root()], 'bound');
  for (const [index, variant] of variants.entries()) {
    const event = reply();
    f.runtime.ingestion.apply('s1', 1, [{
      ...event, ...variant, id: `excluded:${index}`, data: { ...event.data, ...variant.data },
    }], `bound:${index}`);
  }
  assert.equal(replies(f).length, 0);
  assert.equal(f.db.list('native').items.length, 1);
});

test('native evidence contains only identifiers and a content hash, not raw content, attachments or tool payloads', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const attachments = [{ type: 'blob' as const, mimeType: 'text/plain', data: 'cHJpdmF0ZQ==' }];
  const event = reply('output', 'Private answer content');
  event.data.attachments = attachments;
  event.data.toolRequests = [{ id: 'tool', name: 'example', arguments: { text: 'Private tool payload' } }];
  event.data.unrelatedMetadata = 'Private native metadata';
  const input = root();
  input.data.content = 'Private native forwarded input';
  input.data.attachments = attachments;
  f.runtime.ingestion.apply('s1', 1, [input, event], 'page');
  assert.deepEqual(f.db.must('native', fingerprint(['s1', input.id])).event, {
    id: input.id, type: 'user.message', data: { messageId: 'receipt', interactionId: 'interaction' },
  });
  assert.deepEqual(f.db.must('native', fingerprint(['s1', event.id])).event, {
    id: event.id, type: 'assistant.message', data: {
      messageId: 'message:output', interactionId: 'interaction',
      contentFingerprint: fingerprint(['Private answer content', attachments]),
    },
  });
  const stored = JSON.stringify(f.db.list('native').items);
  for (const secret of ['Private', 'cHJpdmF0ZQ==', 'attachments', 'toolRequests', 'unrelatedMetadata'])
    assert.equal(stored.includes(secret), false, secret);
  assert.deepEqual(replies(f)[0]!.attachments, attachments);
  assert.equal(replies(f)[0]!.raw, 'Private answer content');
  assert.equal(f.db.find('messages', message => message.raw === input.data.content).length, 0);
});

test('backward page order resolves roots before replies and replayed forward pages do not duplicate them', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const events = [reply('second', 'Second'), reply('first', 'First'), root()];
  f.db.transaction(() => f.runtime.ingestion.applyWithinTransaction('s1', 1, events, 'backward', true, false,
    new Set(['first', 'second'])));
  assert.equal(f.db.must('receptions', 's1').cursor, '');
  assert.deepEqual(replies(f).map(message => message.raw).sort(), ['First', 'Second']);
  assert.ok(replies(f).every(message => !message.historical));
  const before = conversation(f);
  f.runtime.ingestion.apply('s1', 1, [root(), reply('first', 'First'), reply('second', 'Second')], 'forward');
  assert.deepEqual(conversation(f), before);
  assert.equal(f.db.must('receptions', 's1').cursor, 'forward');
});

test('historical recovery stores bounded business replies without republishing them as live', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const publications = f.db.list('publications').items;
  const events = [root(), reply('old', 'Recovered response'), root('other', 'other', 'other-root'),
    reply('ordinary', 'Ordinary history', 'other')];
  f.runtime.ingestion.apply('s1', 1, events, 'backward', true, false);
  const message = replies(f)[0]!;
  assert.equal(replies(f).length, 2);
  assert.equal(message.historical, true);
  assert.equal(f.db.must('work', `message:${message.id}:1`).state, 'done');
  assert.deepEqual(f.db.list('publications').items, publications);
  assert.equal(f.db.list('native').items.length, 3);
  const before = conversation(f);
  f.runtime.ingestion.apply('s1', 1, [...events].reverse(), 'live');
  assert.deepEqual(conversation(f), before);
  assert.equal(f.db.must('receptions', 's1').cursor, 'live');
});

test('source replacement is versioned once and overlapping recovery cannot replay older observed content', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const old = reply('old-event', 'Original');
  const current = { ...reply('new-event', 'Corrected'),
    data: { ...reply('new-event', 'Corrected').data, messageId: old.data.messageId } };
  f.runtime.ingestion.apply('s1', 1, [root(), old], 'first');
  const message = replies(f)[0]!;
  const publication = f.db.find('publications', item => item.messageId === message.id)[0]!;
  f.runtime.ingestion.apply('s1', 1, [current], 'second');
  assert.equal(replies(f).length, 1);
  assert.equal(f.db.must('messages', message.id).version, 2);
  assert.equal(f.db.must('messages', message.id).raw, 'Corrected');
  assert.equal(f.db.meta<{ raw: string }>(`revision:${message.id}:1`, { raw: '' }).raw, 'Original');
  assert.deepEqual(f.db.must('publications', publication.id), publication);
  assert.equal(f.db.find('publications', item => item.type === 'correction').length, 1);
  const before = conversation(f);
  f.runtime.ingestion.apply('s1', 1, [current, old, root()], 'recovery', true, false);
  assert.deepEqual(conversation(f), before);
  assert.equal(f.db.must('receptions', 's1').cursor, 'second');
});

test('a correction invalidates the original batch attribution without hiding or duplicating the reply', t => {
  const f = fixture(); t.after(() => f.close());
  const original = reply('original', 'First wording');
  f.runtime.ingestion.apply('s1', 1, [original], 'first');
  const message = replies(f)[0]!;
  const batch = f.service.startBatch(f.db.must('bindings', 'coordinator'))!;
  const topic = f.service.topic(f.identities.coordinator, { title: 'Topic', content: '' });
  f.runtime.ingestion.apply('s1', 1, [{ ...reply('correction', 'Corrected wording'),
    data: { ...reply('correction', 'Corrected wording').data, messageId: original.data.messageId },
  }], 'corrected');
  assert.throws(() => f.service.attribute(f.identities.coordinator,
    { items: [{ messageId: message.id, topicId: topic.id }] }), { code: 'STALE_INPUT' });
  assert.equal(f.db.must('work', batch.workIds[0]!).state, 'invalidated');
  assert.equal(f.db.find('publications', p => p.type === 'message' && p.messageId === message.id).length, 1);
  assert.equal(f.db.must('messages', message.id).raw, 'Corrected wording');
});

test('duplicate receipt and changed interaction identities fail atomically without advancing the cursor', () => {
  for (const conflict of ['duplicate-receipt', 'changed-interaction', 'duplicate-interaction'] as const) {
    const f = fixture();
    try {
      stageDelivery(f, { id: 'one', state: 'accepted', nativeMessageId: 'receipt' });
      if (conflict === 'changed-interaction') f.runtime.ingestion.apply('s1', 1, [root()], 'original');
      else stageDelivery(f, { id: 'two', state: 'accepted',
        nativeMessageId: conflict === 'duplicate-receipt' ? 'receipt' : 'second-receipt' });
      const before = conversation(f);
      const cursor = f.db.must('receptions', 's1').cursor;
      const events = conflict === 'changed-interaction'
        ? [root('receipt', 'different', 'changed')]
        : [root(), ...(conflict === 'duplicate-interaction' ? [root('second-receipt', 'interaction', 'second-root')] : []), reply()];
      assert.throws(() => f.runtime.ingestion.apply('s1', 1, events, 'bad'),
        { code: conflict === 'duplicate-receipt' ? 'RECEIPT_CONFLICT' : 'INTERACTION_CONFLICT' });
      assert.deepEqual(conversation(f), before);
      assert.equal(f.db.must('receptions', 's1').cursor, cursor);
    } finally { f.close(); }
  }
});

test('a message cannot change its originating Assistant delivery under the same native message identity', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { id: 'first', state: 'accepted', nativeMessageId: 'first-receipt' });
  stageDelivery(f, { id: 'second', state: 'accepted', nativeMessageId: 'second-receipt' });
  const first = reply('first', 'First answer', 'first-interaction');
  f.runtime.ingestion.apply('s1', 1, [root('first-receipt', 'first-interaction'), first], 'first');
  const before = conversation(f);
  const changed = reply('second', 'Changed source', 'second-interaction');
  changed.data.messageId = first.data.messageId;
  assert.throws(() => f.runtime.ingestion.apply('s1', 1, [
    root('second-receipt', 'second-interaction', 'second-root'), changed,
  ], 'changed'), { code: 'SOURCE_CONFLICT' });
  assert.deepEqual(conversation(f), before);
  assert.equal(f.db.must('receptions', 's1').cursor, 'first');
});

test('relevant event mutation rolls back every source and evidence write in the page', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const event = reply();
  f.runtime.ingestion.apply('s1', 1, [root(), event], 'original');
  const before = conversation(f);
  assert.throws(() => f.runtime.ingestion.apply('s1', 1, [
    reply('new-first', 'This page must roll back'),
    { ...event, data: { ...event.data, content: 'Changed same event' } },
  ], 'bad'), { code: 'EVENT_ID_CONFLICT' });
  assert.deepEqual(conversation(f), before);
  assert.equal(f.db.must('receptions', 's1').cursor, 'original');
});

test('bare lifecycle events cannot establish ask ownership or mark a delivery completed or aborted', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  f.runtime.ingestion.apply('s1', 1, [root(), reply()], 'response');
  const before = conversation(f);
  f.runtime.ingestion.apply('s1', 1, [
    { id: 'start', type: 'assistant.turn_start', data: { turnId: '0' } },
    { id: 'end', type: 'assistant.turn_end', data: { turnId: '0' } },
    { id: 'aborted', type: 'abort', data: { reason: 'User stopped' } },
    { id: 'idle', type: 'session.idle', data: { mode: 'interactive' } },
  ], 'lifecycle');
  assert.deepEqual(conversation(f), before);
  assert.equal(f.db.must('deliveries', 'delivery').interactionState, 'active');
  assert.equal(f.db.list('questions').items.length, 0);
});

test('background reply segments remain attributable after turn end and idle without a new receipt', t => {
  const f = fixture(); t.after(() => f.close());
  const delivery = stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  f.runtime.ingestion.apply('s1', 1, [root(), reply('initial', 'Started background work')], 'initial');
  f.runtime.ingestion.apply('s1', 1, [
    { id: 'end', type: 'assistant.turn_end', data: { turnId: '0' } },
    { id: 'idle', type: 'session.idle', data: { mode: 'interactive' } },
  ], 'idle');
  f.runtime.ingestion.apply('s1', 1, [reply('background', 'Background result')], 'background');
  assert.deepEqual(replies(f).map(message => [message.raw, message.deliveryId]),
    [['Started background work', delivery.id], ['Background result', delivery.id]]);
  assert.equal(f.db.find('work', work => work.kind === 'output').length, 2);
  assert.equal(f.db.list('native').items.length, 3);
  assert.equal(f.db.must('deliveries', delivery.id).interactionId, 'interaction');
  assert.equal(f.db.must('deliveries', delivery.id).interactionState, 'active');
});

test('stale readers and disabled receptions cannot consume a related page', t => {
  const f = fixture(); t.after(() => f.close());
  stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
  const before = conversation(f);
  assert.throws(() => f.runtime.ingestion.apply('s1', 2, [root(), reply()], 'stale'), { code: 'STALE_READER' });
  f.db.put('receptions', { ...f.db.must('receptions', 's1'), enabled: false });
  assert.throws(() => f.runtime.ingestion.apply('s1', 1, [root(), reply()], 'disabled'), { code: 'NOT_RECEPTION' });
  assert.deepEqual(conversation(f), before);
  assert.equal(f.db.must('receptions', 's1').cursor, '');
});

test('receipt association and event deduplication survive process recovery without retaining native bodies', () => {
  const path = `test/.ingestion-${randomUUID()}.sqlite`;
  const f = fixture(path);
  let db: Database | undefined;
  try {
    try {
      stageDelivery(f, { state: 'accepted', nativeMessageId: 'receipt' });
      f.runtime.ingestion.apply('s1', 1, [root(), reply()], 'saved');
    } finally { f.close(); }
    db = new Database(path);
    const service = new AssistantService(db);
    service.recover();
    const ingestion = new Ingestion(service);
    const before = { messages: db.list('messages').items, publications: db.list('publications').items,
      native: db.list('native').items, work: db.list('work').items };
    assert.equal(db.must('receptions', 's1').cursor, 'saved');
    ingestion.apply('s1', 1, [reply(), root()], 'replayed');
    assert.deepEqual({ messages: db.list('messages').items, publications: db.list('publications').items,
      native: db.list('native').items, work: db.list('work').items }, before);
    ingestion.apply('s1', 1, [reply('continuation', 'Later response segment')], 'continued');
    assert.equal(db.find('messages', message => message.kind === 'reply').length, 2);
    assert.equal(db.must('receptions', 's1').cursor, 'continued');
    assert.ok(db.list('native').items.every(item => !('content' in item.event.data) && !('attachments' in item.event.data)));
  } finally {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

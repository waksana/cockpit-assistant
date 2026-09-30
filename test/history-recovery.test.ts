import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routes } from '../src/http.ts';
import { fixture } from './fixtures.ts';

const reply = (id: string) => ({ id, type: 'assistant.message', data: { messageId: id, content: `Reply ${id}` } });
function setup() {
  const f = fixture();
  f.runtime.wake = async () => {};
  const route = routes(f.service, f.runtime).find(item =>
    item.method === 'POST' && item.path === '/sessions/:id/history/recover')!;
  const recover = async (body: unknown, sessionId = 's1', query = {}) =>
    route.handler({ params: { id: sessionId }, body, query, headers: {}, signal: new AbortController().signal });
  return { ...f, recover };
}
const input = { requestId: 'resync', maxPages: 1, evidence: 'Operator acknowledged the expired cursor and bounded history gap' };

test('successful public recovery resumes its forward reader without an unrelated event', async t => {
  const f = fixture(); t.after(() => f.close());
  f.db.put('receptions', { ...f.db.must('receptions', 's1'), cursor: 'expired', gap: 'expired' });
  f.pages.push(
    { events: [], cursor: 'backward', liveCursor: 'resynced-tail', cursorStatus: 'ok', hasMore: false },
    { events: [reply('new')], cursor: 'live-next', cursorStatus: 'ok', hasMore: false },
  );
  const route = routes(f.service, f.runtime).find(item =>
    item.method === 'POST' && item.path === '/sessions/:id/history/recover')!;
  const response = await route.handler({ params: { id: 's1' }, body: input, query: {}, headers: {},
    signal: new AbortController().signal });
  assert.equal(response.status, undefined);
  await f.runtime.settled();
  assert.equal(f.db.must('receptions', 's1').cursor, 'live-next');
  const message = f.db.find('messages', message => message.nativeMessageId === 'new')[0]!;
  assert.equal(message.historical, false);
  assert.equal(f.db.find('publications', p => p.messageId === message.id && p.type === 'message').length, 1);
});

test('public bounded resynchronization clears an expired cursor and preserves historical versus new replies', async t => {
  const f = setup(); t.after(() => f.close());
  f.runtime.ingestion.apply('s1', 1, [reply('seen')], 'previous');
  f.pages.push({ events: [], cursor: null, cursorStatus: 'expired', hasMore: false });
  await f.runtime.consume('s1');
  assert.ok(f.db.must('receptions', 's1').gap);
  f.pages.push({ events: [reply('seen'), reply('recovered')], cursor: 'older', liveCursor: 'new-tail',
    cursorStatus: 'ok', hasMore: true });
  const result = await f.recover(input);
  assert.equal(result.status, undefined);
  assert.equal((result.body as { state: string }).state, 'accepted');
  assert.equal(f.db.must('receptions', 's1').gap, null);
  assert.equal(f.db.must('receptions', 's1').cursor, 'new-tail');
  assert.equal(f.db.must('receptions', 's1').generation, 2);
  const historical = f.db.find('messages', message => message.nativeMessageId === 'recovered')[0]!;
  assert.equal(historical.historical, true);
  assert.equal(f.db.forMessage('work', historical.id).items[0]!.state, 'done');
  assert.equal(f.db.find('publications', p => p.messageId === historical.id).length, 0);
  const reads = f.calls.filter(call => call.name === 'chat').length;
  assert.deepEqual((await f.recover(input)).body, result.body);
  assert.equal(f.calls.filter(call => call.name === 'chat').length, reads);
  assert.equal((await f.recover({ ...input, maxPages: 2 })).status, 409);
  f.pages.push({ events: [reply('recovered'), reply('new')], cursor: 'continued', cursorStatus: 'ok', hasMore: false });
  await f.runtime.consume('s1');
  assert.equal(f.db.find('messages', message => message.kind === 'reply').length, 3);
  const live = f.db.find('messages', message => message.nativeMessageId === 'new')[0]!;
  assert.equal(live.historical, false);
  assert.equal(f.db.find('publications', publication => publication.messageId === live.id && publication.type === 'message').length, 1);
});

test('recovery rejects invalid bounds, missing evidence, unexpected fields and internal targets before reading history', async t => {
  const f = setup(); t.after(() => f.close());
  for (const body of [
    { ...input, maxPages: 0 }, { ...input, maxPages: 11 }, { ...input, maxPages: 1.5 },
    { ...input, evidence: ' ' }, { ...input, evidence: 'x'.repeat(4001) },
    { ...input, requestId: '' }, { ...input, cursor: 'guessed-cursor' },
  ]) assert.equal((await f.recover(body)).status, 400);
  assert.equal((await f.recover(input, 's1', { cursor: 'guessed' })).status, 400);
  assert.equal((await f.recover(input, 'coordinator')).status, 404);
  assert.equal((await f.recover(input, 'missing')).status, 404);
  assert.equal(f.calls.filter(call => call.name === 'chat').length, 0);
  assert.equal(f.db.list('operations').items.length, 0);
});

test('recovery checks the current native identity before reading a former ordinary session', async t => {
  const f = setup(); t.after(() => f.close());
  f.metas.get('s1')!.appliedRoles = [{ moduleId: 'assistant', moduleName: 'Assistant', roleId: 'memory', name: 'Memory' }];
  assert.equal((await f.recover(input)).status, 409);
  assert.equal(f.calls.some(call => call.name === 'chat'), false);
  assert.equal(f.db.must('receptions', 's1').cursor, '');
});

test('partial recovery exposes its saved progress and never replaces or guesses the forward cursor', async t => {
  const f = setup(); t.after(() => f.close());
  f.db.put('receptions', { ...f.db.must('receptions', 's1'), cursor: 'expired-forward', gap: 'expired' });
  let reads = 0;
  f.native.read = async () => {
    if (++reads > 1) throw new Error('Second page unavailable');
    return { events: [reply('recovered')], cursor: 'older', liveCursor: 'frozen-tail', cursorStatus: 'ok', hasMore: true };
  };
  await assert.rejects(f.recover({ ...input, maxPages: 2 }), /Second page unavailable/);
  assert.equal(f.db.must('receptions', 's1').cursor, 'expired-forward');
  assert.equal(f.db.must('receptions', 's1').gap, 'expired');
  const receipt = f.db.must('operations', 'history-recovery:resync');
  assert.equal(receipt.state, 'unknown');
  assert.match(JSON.stringify(receipt.result), /"pages":1/);
  assert.deepEqual((await f.recover({ ...input, maxPages: 2 })).body, receipt);
  assert.equal(reads, 2);
  assert.equal(f.db.list('messages').items[0]!.historical, true);
});

test('recovery does not automatically load an unavailable ordinary session', async t => {
  const f = setup(); t.after(() => f.close());
  f.metas.get('s1')!.loaded = false;
  const response = await f.recover(input);
  assert.equal(response.status, 409);
  assert.equal(f.calls.some(call => call.name === 'session/load' || call.name === 'chat'), false);
  assert.equal(f.db.must('receptions', 's1').cursor, '');
});

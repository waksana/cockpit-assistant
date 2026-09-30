import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixtures.ts';

const transition = () => Object.assign(new Error('Native session metadata is unavailable during a lifecycle transition'),
  { code: 'SESSION_TRANSITION' });

test('session/get transitions retry boundedly and recover without a sticky runtime failure', async t => {
  const f = fixture(); t.after(() => f.close());
  let attempts = 0;
  f.onGet(async id => { if (id === 's1' && ++attempts <= 2) throw transition(); });
  await f.runtime.wake('s1');
  assert.ok(attempts >= 3);
  assert.deepEqual(f.errors, []);
  assert.equal(f.db.meta('metadata:s1', null), null);
  assert.equal(f.db.meta('error:reception:s1', null), null);
  assert.equal(f.db.must('receptions', 's1').enabled, true);
  assert.equal(f.db.must('receptions', 's1').availability, 'loaded');
  assert.equal(f.db.find('publications', p => p.type === 'status' && /metadata is pending/.test(p.text)).length, 1);
  assert.equal(f.db.find('publications', p => p.type === 'status' && /observation recovered/.test(p.text)).length, 1);
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 0);
});

test('exhausted metadata retries leave the role pending, preserve input and recover on a lifecycle observation', async t => {
  const f = fixture(); t.after(() => f.close());
  const input = f.service.accept({ requestId: 'one', text: 'Saved while metadata transitions' });
  let attempts = 0;
  f.onGet(async id => { if (id === 'coordinator') { attempts++; throw transition(); } });
  await f.runtime.wake('coordinator');
  assert.equal(attempts, 3);
  assert.deepEqual(f.db.meta('metadata:coordinator', null), { state: 'pending', attempts: 3, exhausted: true });
  assert.equal(f.db.must('bindings', 'coordinator').ready, false);
  assert.equal((f.db.must('bindings', 'coordinator').evidence as { pending: boolean }).pending, true);
  assert.equal(f.db.must('work', input.work.id).state, 'pending');
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 0);
  assert.deepEqual(f.errors, []);
  const readiness = await f.runtime.readiness();
  assert.equal(readiness.canSend, false);
  assert.equal(readiness.roles.find(role => role.role === 'coordinator')!.status, 'unknown');
  assert.match(readiness.roles.find(role => role.role === 'coordinator')!.detail!, /metadata is pending/);
  assert.equal(attempts, 6, 'each explicit metadata observation makes at most three reads');
  f.onGet(null);
  await f.runtime.wake('coordinator');
  assert.equal(f.db.must('bindings', 'coordinator').ready, true);
  assert.equal(f.db.meta('metadata:coordinator', null), null);
  assert.equal(f.db.must('messages', input.message.id).raw, input.message.raw);
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  assert.deepEqual(f.errors, []);
});

test('real session/get failures are neither retried as transitions nor hidden from the runtime reporter', async t => {
  const f = fixture(); t.after(() => f.close());
  const failure = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  let attempts = 0;
  f.onGet(async id => { if (id === 's1') { attempts++; throw failure; } });
  await f.runtime.wake('s1');
  assert.equal(attempts, 1);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.db.meta('error:reception:s1', null), 'Permission denied');
});

test('a similarly named failure from another host operation is not swallowed as session metadata pending', async t => {
  const f = fixture(); t.after(() => f.close());
  const failure = transition();
  f.onReadiness(async id => { if (id === 'coordinator') throw failure; });
  await f.runtime.wake('coordinator');
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.db.meta('metadata:coordinator', null), null);
  assert.equal(f.db.must('bindings', 'coordinator').ready, false);
});

test('stopping during a metadata retry performs no later native read or global error report', async t => {
  const f = fixture(); t.after(() => f.close());
  let attempts = 0;
  f.onGet(async id => { if (id === 's1') { attempts++; throw transition(); } });
  const pending = f.runtime.wake('s1');
  while (!attempts) await new Promise(resolve => setImmediate(resolve));
  f.runtime.stop();
  await pending;
  assert.equal(attempts, 1);
  assert.deepEqual(f.errors, []);
});

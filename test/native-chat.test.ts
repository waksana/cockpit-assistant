import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import type { ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody, ModuleHostIntentResult,
  PublicSessionMeta } from '@waksana/cockpit-module-sdk/backend';
import { NativeChat } from '../src/native-chat.ts';
import { Store } from '../src/store.ts';

function fixture(selected: string | null = null) {
  const store = new Store(':memory:');
  const calls: { name: ModuleHostIntent; body: unknown }[] = [];
  const meta = (sessionId: string): PublicSessionMeta => ({
    sessionId, cwd: '/synthetic', title: sessionId, status: 'idle', loaded: true, lastActivity: 1, ask: null,
  });
  const sessions = new Map(['front', 'other'].map(id => [id, meta(id)]));
  let read: ((sessionId: string) => Promise<PublicSessionMeta | null>) | null = null;
  const host: ModuleHostApi = {
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body });
      assert.equal(name, 'session/get', 'No history, roles, resources, prompts, creation or loading');
      const { sessionId } = body as ModuleHostIntentBody<'session/get'>;
      const result = { meta: read ? await read(sessionId) : structuredClone(sessions.get(sessionId) ?? null) };
      return result as ModuleHostIntentResult<Name>;
    },
  };
  const chat = new NativeChat(host, store, selected);
  const identity = { sessionId: 'front', runtimeSessionId: 'front', subagent: false, toolCallId: 'native-tool' };
  return { store, host, chat, identity, sessions, calls,
    readWith(value: typeof read) { read = value; },
    reopen(configured: string | null = selected) { chat.close(); return new NativeChat(host, store, configured); },
    close() { chat.close(); store.close(); },
  };
}

test('caller returns only exact Host invocation identities without foreground selection', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.chat.caller(f.identity), { sessionId: 'front', toolCallId: 'native-tool' });
    assert.deepEqual(f.calls, [{ name: 'session/get', body: { sessionId: 'front' } }]);
    assert.equal(await f.chat.foreground(), null);
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
    assert.equal('accepted' in f.chat, false);
    assert.equal('observe' in f.chat, false);
  } finally { f.close(); }
});

test('different, absent and unapplied roles do not gate a Host-authorized caller', async () => {
  const f = fixture('other');
  try {
    const meta = f.sessions.get('front')!;
    for (const roleId of ['coordinator', 'organizer', 'worker', 'unrelated']) {
      meta.roles = [{ moduleId: roleId === 'unrelated' ? 'another-module' : 'assistant', roleId,
        name: 'Synthetic role', moduleName: 'Synthetic module' }];
      meta.appliedRoles = []; meta.rolesNeedReload = true;
      assert.deepEqual(await f.chat.caller(f.identity), { sessionId: 'front', toolCallId: 'native-tool' });
    }
    delete meta.roles; delete meta.appliedRoles; delete meta.rolesNeedReload;
    meta.loaded = false;
    assert.deepEqual(await f.chat.caller(f.identity), { sessionId: 'front', toolCallId: 'native-tool' });
    assert.equal((await f.chat.foreground())!.sessionId, 'other', 'Configured foreground is not caller eligibility');
    assert.equal(f.store.receipt('evidence:foreground'), null);
    assert.ok(f.calls.every(call => call.name === 'session/get'));
  } finally { f.close(); }
});

test('module and API origin labels require no ingress receipts or origin/history scans', async () => {
  const f = fixture();
  try {
    for (const origin of ['module', 'api']) {
      const identity = { ...f.identity, origin, toolCallId: `${origin}-native-tool` };
      assert.deepEqual(await f.chat.caller(identity), { sessionId: 'front', toolCallId: identity.toolCallId });
    }
    assert.deepEqual(f.calls.map(call => call.name), ['session/get', 'session/get']);
    assert.equal(await f.chat.foreground(), null);
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
  } finally { f.close(); }
});

test('missing tool IDs and inconsistent native session attribution reject before Host reads', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { runtimeSessionId: 'other' }, { sessionId: '', runtimeSessionId: '' },
      { sessionId: ' ', runtimeSessionId: ' ' }, { toolCallId: undefined }, { toolCallId: '' }, { toolCallId: ' ' },
      { runtimeSessionId: 'other', subagent: true },
    ]) await assert.rejects(f.chat.caller({ ...f.identity, ...patch }), { code: 'CALLER_IDENTITY' });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.chat.caller({ ...f.identity, subagent: true }),
      { sessionId: 'front', toolCallId: 'native-tool' }, 'Host metadata flags do not replace exact native identity checks');
  } finally { f.close(); }
});

test('missing caller sessions, mismatched readback and failed native reads fail explicitly', async () => {
  const f = fixture();
  try {
    f.sessions.delete('front');
    await assert.rejects(f.chat.caller(f.identity), { code: 'CALLER_MISSING' });
    assert.equal(await f.chat.session('front'), null);
    f.readWith(async () => f.sessions.get('other')!);
    await assert.rejects(f.chat.caller(f.identity), { code: 'SESSION_MISMATCH' });
    await assert.rejects(f.chat.session('front'), { code: 'SESSION_MISMATCH' });
    f.readWith(async () => { throw new Error('Synthetic native read failure'); });
    await assert.rejects(f.chat.caller(f.identity), /Synthetic native read failure/);
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
  } finally { f.close(); }
});

test('explicit foreground selection reads existing unloaded sessions without resource checks or loading', async () => {
  const f = fixture();
  try {
    assert.equal(await f.chat.foreground(), null);
    assert.deepEqual(f.calls, []);
    f.sessions.get('other')!.loaded = false;
    await f.chat.setForeground('other');
    assert.deepEqual(f.calls, [{ name: 'session/get', body: { sessionId: 'other' } }]);
    assert.equal(f.store.state('foreground', z.string().nullable()), 'other');
    assert.deepEqual(await f.chat.foreground(), f.sessions.get('other'));
    const reads = f.calls.length;
    await f.chat.setForeground(null);
    assert.equal(await f.chat.foreground(), null);
    assert.equal(f.calls.length, reads, 'Clearing selection performs no native operations');
    assert.equal(f.store.state('foreground', z.string().nullable()), null);
    assert.ok(f.store.receipt('evidence:foreground'), 'An explicit null remains a persisted selection');
  } finally { f.close(); }
});

test('missing original foreground and failed lookup preserve identity instead of replacing it', async () => {
  const f = fixture('front');
  try {
    f.sessions.delete('front');
    assert.equal(f.chat.foregroundId(), 'front');
    assert.deepEqual(f.calls, [], 'Reading the selected ID never queries the Host');
    await assert.rejects(f.chat.foreground(), { code: 'FOREGROUND_MISSING' });
    await f.chat.caller({ ...f.identity, sessionId: 'other', runtimeSessionId: 'other' });
    await assert.rejects(f.chat.foreground(), { code: 'FOREGROUND_MISSING' });
    f.readWith(async () => { throw new Error('Synthetic read failure'); });
    await assert.rejects(f.chat.foreground(), /Synthetic read failure/);
    const reads = f.calls.length;
    assert.equal(f.chat.foregroundId(), 'front');
    assert.equal(f.calls.length, reads);
    f.readWith(async () => f.sessions.get('other')!);
    await assert.rejects(f.chat.foreground(), { code: 'SESSION_MISMATCH' });
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
  } finally { f.close(); }
});

test('failed explicit selection never overwrites the previous persisted choice', async () => {
  const f = fixture('other');
  try {
    await f.chat.setForeground('front');
    await assert.rejects(f.chat.setForeground('missing'), { code: 'FOREGROUND_MISSING' });
    f.readWith(async () => { throw new Error('Synthetic selection read failure'); });
    await assert.rejects(f.chat.setForeground('other'), /Synthetic selection read failure/);
    f.readWith(async () => f.sessions.get('front')!);
    await assert.rejects(f.chat.setForeground('other'), { code: 'SESSION_MISMATCH' });
    f.readWith(null);
    assert.equal((await f.chat.foreground())!.sessionId, 'front');
    assert.equal(f.chat.foregroundId(), 'front');
    assert.equal(f.store.state('foreground', z.string().nullable()), 'front');
  } finally { f.close(); }
});

test('persisted explicit ID or null takes precedence over configuration and legacy selection on restart', async () => {
  for (const selected of ['other', null]) {
    const f = fixture('front');
    let restored: NativeChat | undefined;
    try {
      f.store.remember('foreground', 'front');
      await f.chat.setForeground(selected);
      restored = f.reopen('front');
      const reads = f.calls.length;
      assert.equal(restored.foregroundId(), selected);
      assert.equal(f.calls.length, reads);
      assert.equal((await restored.foreground())?.sessionId ?? null, selected);
      assert.equal(f.store.receipt('foreground')!.fingerprint, 'front', 'Legacy identity is not rewritten');
    } finally { restored?.close(); f.close(); }
  }
});

test('foreground selection survives closing and reopening its database', async () => {
  for (const selected of ['other', null]) {
    const f = fixture();
    const root = join(process.cwd(), `.native-chat-test-${randomUUID()}`);
    let disk: Store | undefined, chat: NativeChat | undefined;
    await mkdir(root, { mode: 0o700 });
    try {
      const path = join(root, 'state.sqlite');
      disk = new Store(path); disk.remember('foreground', 'front');
      chat = new NativeChat(f.host, disk, 'front');
      assert.equal(chat.foregroundId(), 'front');
      await chat.setForeground(selected);
      assert.equal(chat.foregroundId(), selected);
      chat.close(); disk.close(); disk = undefined;
      disk = new Store(path);
      chat = new NativeChat(f.host, disk, 'front');
      assert.equal(chat.foregroundId(), selected);
      assert.equal((await chat.foreground())?.sessionId ?? null, selected);
      assert.equal(disk.state('foreground', z.string().nullable()), selected);
    } finally {
      chat?.close(); disk?.close(); f.close();
      await rm(root, { recursive: true });
    }
  }
});

test('without explicit state, configuration wins and the legacy ID remains a fallback without auto-selection', async () => {
  const f = fixture();
  let configured: NativeChat | undefined, legacy: NativeChat | undefined;
  try {
    f.store.remember('foreground', 'other');
    configured = new NativeChat(f.host, f.store, 'front');
    legacy = new NativeChat(f.host, f.store, null);
    assert.equal((await configured.foreground())!.sessionId, 'front');
    assert.equal((await legacy.foreground())!.sessionId, 'other');
    await legacy.caller(f.identity);
    assert.equal((await legacy.foreground())!.sessionId, 'other');
    assert.equal(f.store.receipt('evidence:foreground'), null, 'Read-only lookup never migrates or replaces selection');
  } finally { configured?.close(); legacy?.close(); f.close(); }
});

test('closing rejects ingress and selection writes but preserves passive drain readback', async () => {
  const f = fixture('front');
  try {
    f.chat.close(); f.chat.close();
    assert.equal(f.chat.foregroundId(), 'front');
    await assert.rejects(f.chat.caller(f.identity), { code: 'STOPPING' });
    await assert.rejects(f.chat.setForeground('front'), { code: 'STOPPING' });
    await assert.rejects(f.chat.setForeground(null), { code: 'STOPPING' });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.chat.session('front'), f.sessions.get('front'));
    f.sessions.get('front')!.loaded = false;
    assert.deepEqual(await f.chat.foreground(), f.sessions.get('front'), 'Drain reads actual changed native state');
    assert.deepEqual(f.calls, [
      { name: 'session/get', body: { sessionId: 'front' } },
      { name: 'session/get', body: { sessionId: 'front' } },
    ]);
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
  } finally { f.close(); }
});

test('passive readback started before close still reports native identity and errors faithfully', async () => {
  for (const operation of ['session', 'foreground'] as const) {
    const f = fixture('front');
    try {
      let release!: (value: PublicSessionMeta | null) => void;
      f.readWith(() => new Promise(resolve => { release = resolve; }));
      const pending = operation === 'session' ? f.chat.session('front') : f.chat.foreground();
      f.chat.close();
      release(f.sessions.get('front')!);
      assert.deepEqual(await pending, f.sessions.get('front'));
      f.readWith(async () => f.sessions.get('other')!);
      await assert.rejects(f.chat.foreground(), { code: 'SESSION_MISMATCH' });
      f.readWith(async () => null);
      assert.equal(await f.chat.session('front'), null);
      await assert.rejects(f.chat.foreground(), { code: 'FOREGROUND_MISSING' });
      f.readWith(async () => { throw new Error('Synthetic drain read failure'); });
      await assert.rejects(f.chat.foreground(), /Synthetic drain read failure/);
    } finally { f.close(); }
  }
  const empty = fixture();
  try {
    empty.chat.close();
    assert.equal(empty.chat.foregroundId(), null);
    assert.equal(await empty.chat.foreground(), null);
    assert.deepEqual(empty.calls, []);
  } finally { empty.close(); }
});

test('closing during native read prevents late caller admission and foreground persistence', async () => {
  for (const operation of ['caller', 'setForeground'] as const) {
    const f = fixture();
    try {
      let release!: (value: PublicSessionMeta | null) => void;
      f.readWith(() => new Promise(resolve => { release = resolve; }));
      const pending = operation === 'caller' ? f.chat.caller(f.identity) : f.chat.setForeground('front');
      f.chat.close();
      release(f.sessions.get('front')!);
      await assert.rejects(pending, { code: 'STOPPING' });
      assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
    } finally { f.close(); }
  }
});

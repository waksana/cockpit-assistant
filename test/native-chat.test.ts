import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import type { ModuleHostApi, ModuleHostIntent, ModuleHostIntentBody, ModuleHostIntentResult,
  PublicSessionMeta, RoleAssignment } from '@waksana/cockpit-module-sdk/backend';
import { NativeChat } from '../src/native-chat.ts';
import { Store } from '../src/store.ts';

const coordinator = { moduleId: 'assistant', roleId: 'coordinator', name: 'Coordinator', moduleName: 'Assistant' };
const connector = { moduleId: 'connector', roleId: 'neutral', name: 'Neutral', moduleName: 'Connector' };
const assignment = (sessionId = 'front', roles = [coordinator]): RoleAssignment =>
  ({ operation: 'add', sessionId, roles, previousRoles: [] });
const signal = () => new AbortController().signal;
type Directory = ModuleHostIntentResult<'session/directory'>;
function fixture(legacy: string | null = null) {
  const store = new Store(':memory:');
  const calls: { name: ModuleHostIntent; body: unknown }[] = [];
  const meta = (sessionId: string): PublicSessionMeta => ({
    sessionId, cwd: '/synthetic', title: sessionId, status: 'idle', loaded: true, lastActivity: 1, ask: null,
  });
  const sessions = new Map(['front', 'other'].map(id => [id, meta(id)]));
  let read: ((sessionId: string) => Promise<PublicSessionMeta | null>) | null = null;
  let directory: ((body: ModuleHostIntentBody<'session/directory'>) => Promise<Directory>) | null = null;
  const host: ModuleHostApi = {
    async call<Name extends ModuleHostIntent>(name: Name, body: ModuleHostIntentBody<Name>): Promise<ModuleHostIntentResult<Name>> {
      calls.push({ name, body });
      if (name === 'session/directory') {
        return (directory ? await directory(body as ModuleHostIntentBody<'session/directory'>)
          : { sessions: structuredClone([...sessions.values()]) }) as ModuleHostIntentResult<Name>;
      }
      assert.equal(name, 'session/get', 'Only passive public metadata reads are allowed');
      const { sessionId } = body as ModuleHostIntentBody<'session/get'>;
      return { meta: read ? await read(sessionId) : structuredClone(sessions.get(sessionId) ?? null) } as ModuleHostIntentResult<Name>;
    },
  };
  const chat = new NativeChat(host, store, legacy);
  const identity = { sessionId: 'front', runtimeSessionId: 'front', subagent: false, toolCallId: 'native-tool' };
  return { store, host, chat, identity, sessions, calls,
    owner(id = 'front', loaded = true) {
      Object.assign(sessions.get(id)!, { roles: [coordinator], appliedRoles: loaded ? [coordinator] : [],
        loaded, rolesNeedReload: false });
    },
    readWith(value: typeof read) { read = value; },
    directoryWith(value: typeof directory) { directory = value; },
    close() { chat.close(); store.close(); },
  };
}

test('caller returns exact Host invocation identities without foreground selection or origin scans', async () => {
  const f = fixture();
  try {
    for (const origin of ['module', 'api', 'human']) {
      const identity = { ...f.identity, origin };
      assert.deepEqual(await f.chat.caller(identity),
        { sessionId: 'front', toolCallId: 'native-tool' });
    }
    assert.deepEqual(f.calls.map(call => call.name), ['session/get', 'session/get', 'session/get']);
    assert.equal(await f.chat.foreground(), null);
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
    for (const removed of ['accepted', 'observe', 'setForeground']) assert.equal(removed in f.chat, false);
  } finally { f.close(); }
});

test('different, absent and unapplied roles do not gate a Host-authorized caller', async () => {
  const f = fixture('other');
  try {
    const meta = f.sessions.get('front')!;
    for (const roleId of ['coordinator', 'organizer', 'worker', 'unrelated']) {
      meta.roles = [{ ...coordinator, moduleId: roleId === 'unrelated' ? 'another-module' : 'assistant', roleId }];
      meta.appliedRoles = []; meta.rolesNeedReload = true;
      assert.deepEqual(await f.chat.caller(f.identity), { sessionId: 'front', toolCallId: 'native-tool' });
    }
    delete meta.roles; delete meta.appliedRoles; delete meta.rolesNeedReload;
    meta.loaded = false;
    assert.deepEqual(await f.chat.caller(f.identity), { sessionId: 'front', toolCallId: 'native-tool' });
    assert.ok(f.calls.every(call => call.name === 'session/get'));
    assert.equal(await f.chat.foreground(), null, 'Legacy configuration is inert');
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
      { sessionId: 'front', toolCallId: 'native-tool' });
  } finally { f.close(); }
});

test('missing callers, mismatched readback and failed native reads fail explicitly', async () => {
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

test('direct session, caller and foreground reads still propagate original transition errors', async () => {
  const f = fixture(), error = Object.assign(new Error('metadata transition'), { code: 'SESSION_TRANSITION' });
  try {
    f.owner();
    f.readWith(async () => { throw error; });
    await assert.rejects(f.chat.session('front'), value => value === error);
    await assert.rejects(f.chat.caller(f.identity), value => value === error);
    await assert.rejects(f.chat.foreground(), value => value === error);
    assert.equal(f.chat.foregroundId(), null);
    f.directoryWith(async () => { throw error; });
    await assert.rejects(f.chat.availability({ ...assignment(), operation: 'add' }, signal()), value => value === error);
    await assert.rejects(f.chat.permit(assignment(), signal()), value => value === error);
  } finally { f.close(); }
});

test('configuration, old receipt and explicit foreground ID/null stay unchanged inert archives across restart', async () => {
  for (const previous of ['other', null]) {
    const f = fixture('front');
    const root = join(process.cwd(), `.native-chat-test-${randomUUID()}`);
    let disk: Store | undefined, chat: NativeChat | undefined;
    await mkdir(root, { mode: 0o700 });
    try {
      const path = join(root, 'state.sqlite');
      disk = new Store(path);
      disk.remember('foreground', 'front');
      disk.saveState('foreground', previous, z.string().nullable());
      const archived = disk.sql.prepare('SELECT * FROM seen ORDER BY id').all();
      chat = new NativeChat(f.host, disk, 'front');
      assert.equal(chat.foregroundId(), null);
      assert.deepEqual(f.calls, [], 'Construction performs no replay or migration');
      assert.equal(await chat.foreground(), null);
      await chat.caller(f.identity);
      assert.equal(await chat.foreground(), null, 'Chat does not claim ownership');
      chat.close(); disk.close(); disk = new Store(path);
      chat = new NativeChat(f.host, disk, 'front');
      f.owner('other');
      assert.equal((await chat.foreground())!.sessionId, 'other');
      assert.deepEqual(disk.sql.prepare('SELECT * FROM seen ORDER BY id').all(), archived);
    } finally { chat?.close(); disk?.close(); f.close(); await rm(root, { recursive: true }); }
  }
});

test('unique saved coordinator is discovered passively; neutral connector roles coexist', async () => {
  const f = fixture();
  try {
    f.owner();
    f.sessions.get('front')!.roles!.push(connector);
    f.sessions.get('front')!.appliedRoles!.push(connector);
    assert.equal((await f.chat.foreground())!.sessionId, 'front');
    assert.equal(f.chat.foregroundId(), 'front');
    assert.deepEqual(f.calls, [
      { name: 'session/directory', body: { limit: 100 } },
      { name: 'session/get', body: { sessionId: 'front' } },
    ]);
    assert.deepEqual(await f.chat.availability(assignment('front', [coordinator, connector]), signal()), { reasons: [] });
    assert.deepEqual(await f.chat.permit(assignment('front', [coordinator, connector]), signal()), { allowed: true });
  } finally { f.close(); }
});

test('unloaded saved owner is accepted without loading; loaded owner requires applied role and no reload', async () => {
  const f = fixture();
  try {
    f.owner('front', false);
    f.sessions.get('front')!.rolesNeedReload = true;
    assert.equal((await f.chat.foreground())!.loaded, false);
    f.sessions.get('front')!.loaded = true;
    await assert.rejects(f.chat.foreground(), { code: 'COORDINATOR_NOT_APPLIED' });
    f.sessions.get('front')!.rolesNeedReload = false;
    await assert.rejects(f.chat.foreground(), { code: 'COORDINATOR_NOT_APPLIED' });
    f.sessions.get('front')!.appliedRoles = [connector];
    await assert.rejects(f.chat.foreground(), { code: 'COORDINATOR_NOT_APPLIED' });
    assert.equal(f.chat.foregroundId(), null);
    f.sessions.get('front')!.appliedRoles = [coordinator];
    assert.equal((await f.chat.foreground())!.sessionId, 'front');
  } finally { f.close(); }
});

test('ownership is global for create and add; same owner and unrelated roles remain allowed', async () => {
  const f = fixture();
  try {
    for (const operation of ['create', 'add'] as const) {
      assert.deepEqual(await f.chat.permit({ ...assignment(), operation }, signal()), { allowed: true });
      f.owner();
      const different = { ...assignment('other'), operation };
      assert.equal((await f.chat.availability(different, signal())).reasons[0]!.code, 'COORDINATOR_OWNED');
      assert.equal((await f.chat.permit(different, signal())).allowed, false);
      assert.deepEqual(await f.chat.permit({ ...assignment(), operation }, signal()), { allowed: true });
      f.sessions.get('front')!.roles = [];
    }
    f.owner();
    assert.equal((await f.chat.availability({ operation: 'create', roles: [coordinator], previousRoles: [] }, signal()))
      .reasons[0]!.status, 'denied');
    const reads = f.calls.length;
    assert.deepEqual(await f.chat.permit(assignment('other', [connector]), signal()), { allowed: true });
    assert.equal(f.calls.length, reads, 'Non-coordinator roles impose no ownership check');
    f.sessions.delete('front');
    assert.deepEqual(await f.chat.permit(assignment('other'), signal()), { allowed: true });
    assert.equal(await f.chat.foreground(), null, 'Deleted owner has no stale fallback');
  } finally { f.close(); }
});

test('multiple pre-existing owners explicitly conflict, including additions to one of those owners', async () => {
  const f = fixture();
  try {
    f.owner(); await f.chat.foreground();
    f.owner('other');
    await assert.rejects(f.chat.foreground(), { code: 'COORDINATOR_CONFLICT' });
    assert.equal(f.chat.foregroundId(), null);
    assert.equal((await f.chat.availability(assignment(), signal())).reasons[0]!.code, 'COORDINATOR_CONFLICT');
    assert.equal((await f.chat.permit(assignment(), signal())).allowed, false);
    assert.equal(f.calls.filter(call => call.name === 'session/get').length, 1, 'Conflict never chooses a first/latest owner');
  } finally { f.close(); }
});

test('bounded directory pagination scans all pages, not just an early owner', async () => {
  const f = fixture();
  try {
    f.owner('other');
    f.directoryWith(async ({ cursor, limit }) => {
      assert.equal(limit, 100);
      return cursor ? { sessions: [f.sessions.get('other')!] } : { sessions: [f.sessions.get('front')!], cursor: 'next' };
    });
    assert.equal((await f.chat.foreground())!.sessionId, 'other');
    assert.equal((await f.chat.availability(assignment(), signal())).reasons[0]!.code, 'COORDINATOR_OWNED');
    f.owner('front');
    await assert.rejects(f.chat.foreground(), { code: 'COORDINATOR_CONFLICT' });
  } finally { f.close(); }
});

test('partial, malformed, repeating and over-budget directories never imply no owner or allow admission', async () => {
  const f = fixture();
  try {
    const failures: Array<(body: ModuleHostIntentBody<'session/directory'>) => Promise<Directory>> = [
      async ({ cursor }) => { if (cursor) throw new Error('Directory unavailable'); return { sessions: [], cursor: 'next' }; },
      async () => ({ sessions: [], cursor: 'repeat' }),
      async () => ({ sessions: [f.sessions.get('front')!], cursor: randomUUID() }),
      async () => ({ sessions: [], cursor: randomUUID() }),
      async () => ({ cursor: 'missing-sessions' }) as Directory,
      async () => ({ sessions: [], cursor: '' }),
    ];
    for (const read of failures) {
      f.directoryWith(read);
      await assert.rejects(f.chat.foreground());
      assert.equal(f.chat.foregroundId(), null);
      await assert.rejects(f.chat.availability(assignment(), signal()));
      await assert.rejects(f.chat.permit(assignment(), signal()));
    }
    assert.ok(f.calls.every(call => call.name === 'session/directory'));
  } finally { f.close(); }
});

test('exact readback must still exist and retain the saved coordinator role', async () => {
  const f = fixture();
  try {
    f.owner();
    f.readWith(async () => null);
    await assert.rejects(f.chat.foreground(), { code: 'COORDINATOR_CHANGED' });
    f.readWith(async () => f.sessions.get('other')!);
    await assert.rejects(f.chat.foreground(), { code: 'SESSION_MISMATCH' });
    f.readWith(async () => ({ ...f.sessions.get('front')!, roles: [] }));
    await assert.rejects(f.chat.foreground(), { code: 'COORDINATOR_CHANGED' });
    assert.equal(f.chat.foregroundId(), null);
  } finally { f.close(); }
});

test('explicit invalidation and saved-role changes prevent older discovery restoring stale identity', async () => {
  for (const invalidate of ['discovery', 'saved', 'close'] as const) {
    const f = fixture();
    try {
      f.owner();
      let release!: (meta: PublicSessionMeta | null) => void;
      const waiting = new Promise<void>(resolve => f.readWith(() => {
        resolve(); return new Promise(done => { release = done; });
      }));
      const older = f.chat.foreground();
      await waiting;
      const stale = structuredClone(f.sessions.get('front')!);
      f.readWith(null);
      f.sessions.get('front')!.roles = []; f.owner('other');
      if (invalidate === 'discovery') {
        f.chat.invalidateForeground();
        assert.equal((await f.chat.foreground())!.sessionId, 'other');
      }
      else if (invalidate === 'close') f.chat.close();
      else {
        const calls = f.calls.length;
        f.chat.saved({ ...assignment('other'), notificationId: 'saved' }, signal());
        assert.equal(f.calls.length, calls, 'Saved hook performs no Host calls or notification work');
      }
      release(stale);
      await assert.rejects(older, { code: invalidate === 'close' ? 'STOPPING' : 'FOREGROUND_CHANGED' });
      assert.equal(f.chat.foregroundId(), invalidate === 'discovery' ? 'other' : null);
    } finally { f.close(); }
  }
});

test('concurrent passive health and notification discovery share a read without invalidating one another', async () => {
  const f = fixture();
  try {
    f.owner();
    let release!: (meta: PublicSessionMeta | null) => void;
    const waiting = new Promise<void>(resolve => f.readWith(() => {
      resolve(); return new Promise(done => { release = done; });
    }));
    const first = f.chat.foreground();
    await waiting;
    const before = f.calls.length;
    const second = f.chat.foreground();
    assert.equal(f.calls.length, before);
    release(structuredClone(f.sessions.get('front')!));
    const results = await Promise.all([first, second]);
    assert.ok(results.every(meta => meta?.sessionId === 'front'));
    assert.equal(f.chat.foregroundId(), 'front');
  } finally { f.close(); }
});

test('unsuccessful discovery clears a previously verified owner rather than falling back to it', async () => {
  const f = fixture();
  try {
    f.owner();
    assert.equal((await f.chat.foreground())?.sessionId, 'front');
    f.directoryWith(async () => { throw new Error('directory unavailable'); });
    await assert.rejects(f.chat.foreground(), /directory unavailable/);
    assert.equal(f.chat.foregroundId(), null);
    f.directoryWith(null);
    await f.chat.foreground();
    f.sessions.get('front')!.roles = [];
    assert.equal(await f.chat.foreground(), null);
    assert.equal(f.chat.foregroundId(), null);
  } finally { f.close(); }
});

test('abort and stop fence role checks before reads and prevent late admission after awaited reads', async () => {
  for (const operation of ['availability', 'permit'] as const) {
    for (const interrupt of ['abort', 'close'] as const) {
      const f = fixture(), controller = new AbortController();
      try {
        let release!: (page: Directory) => void;
        f.directoryWith(() => new Promise(resolve => { release = resolve; }));
        const pending = f.chat[operation](assignment(), controller.signal);
        if (interrupt === 'abort') controller.abort(); else f.chat.close();
        release({ sessions: [] });
        await assert.rejects(pending, { code: 'STOPPING' });
        const calls = f.calls.length;
        await assert.rejects(f.chat[operation](assignment(), controller.signal), { code: 'STOPPING' });
        assert.equal(f.calls.length, calls);
      } finally { f.close(); }
    }
  }
});

test('close prevents late caller admission and destination use but allows passive session drain reads', async () => {
  const f = fixture();
  try {
    let release!: (value: PublicSessionMeta | null) => void;
    f.readWith(() => new Promise(resolve => { release = resolve; }));
    const pending = f.chat.caller(f.identity);
    f.chat.close(); release(f.sessions.get('front')!);
    await assert.rejects(pending, { code: 'STOPPING' });
    f.readWith(null);
    assert.deepEqual(await f.chat.session('front'), f.sessions.get('front'));
    await assert.rejects(f.chat.foreground(), { code: 'STOPPING' });
    assert.equal(f.chat.foregroundId(), null);
    assert.deepEqual(f.store.sql.prepare('SELECT * FROM seen').all(), []);
  } finally { f.close(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database } from '../src/database.ts';
import { AssistantService } from '../src/service.ts';
import { acquireLease } from '../src/lease.ts';
import { publicationStream } from '../src/stream.ts';
import { Readable } from 'node:stream';

test('killed writer preserves acknowledged input and turns in-flight effects into unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-crash-test-'));
  const path = join(directory, 'state.sqlite');
  try {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { Database } from './src/database.ts';
      import { AssistantService } from './src/service.ts';
      const db = new Database(process.argv[1]);
      const service = new AssistantService(db);
      service.accept({requestId:'durable',text:'Persist before acknowledgment'});
      db.transaction(() => db.put('deliveries', {
        id:'effect',kind:'prompt',messageId:null,sessionId:'synthetic',requestId:null,
        text:'Synthetic effect',supplement:null,answerFreeform:null,state:'calling',
        result:null,error:null,createdAt:0,roleEpoch:null
      }));
      process.kill(process.pid, 'SIGKILL');
    `, path], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(run.signal, 'SIGKILL', run.stderr);
    const db = new Database(path);
    try {
      const service = new AssistantService(db);
      service.recover();
      assert.equal(db.list('messages').items[0]?.raw, 'Persist before acknowledgment');
      assert.equal(db.must('deliveries', 'effect').state, 'unknown');
      assert.match(db.must('deliveries', 'effect').error!, /not repeated/);
      assert.equal(service.accept({ requestId: 'durable', text: 'Persist before acknowledgment' }).message.id,
        db.list('messages').items[0]?.id);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

test('SQLite transaction rollback never publishes a partial acknowledgment', () => {
  const db = new Database(':memory:');
  try {
    const service = new AssistantService(db);
    assert.throws(() => db.transaction(() => {
      service.addMessage({ kind: 'user', raw: 'Uncommitted' });
      service.publish({ type: 'status', text: 'Uncommitted' });
      throw new Error('simulated failure');
    }));
    assert.equal(db.list('messages').items.length, 0);
    assert.equal(db.list('publications').items.length, 0);
  } finally { db.close(); }
});

test('writer fencing excludes a second activation but releases normally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-lease-test-'));
  let release: (() => void) | undefined;
  try {
    release = await acquireLease(directory);
    await assert.rejects(acquireLease(directory), /EADDRINUSE/);
    release(); release = undefined;
    const again = await acquireLease(directory);
    again();
  } finally {
    release?.();
    await rm(directory, { recursive: true });
  }
});

test('SSE resumes after persisted sequence and sends a complete message, not tokens', async () => {
  const db = new Database(':memory:');
  const controller = new AbortController();
  try {
    const service = new AssistantService(db);
    db.transaction(() => {
      service.publish({ type: 'message', text: 'One' });
      service.publish({ type: 'message', text: 'Two complete paragraphs.\n\nNot token deltas.' });
    });
    const response = publicationStream(service, 1, controller.signal);
    assert.ok(response.body instanceof Readable);
    const iterator = response.body[Symbol.asyncIterator]();
    const frame = await iterator.next();
    assert.match(String(frame.value), /id: 2/);
    assert.match(String(frame.value), /Two complete paragraphs/);
    assert.doesNotMatch(String(frame.value), /"text":"One"/);
    controller.abort();
    await iterator.return?.();
  } finally { controller.abort(); db.close(); }
});

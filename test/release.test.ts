import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error Release scripts execute directly in Node; they are not part of the TS runtime.
import { identity, repository, checkEvent, assetNames, hash, verifyAssets, product, assertMigrationTargets } from '../scripts/release-contract.mjs';
// @ts-expect-error Release scripts execute directly in Node; they are not part of the TS runtime.
import { publish, snapshot } from '../scripts/release.mjs';
// @ts-expect-error Migration declaration helpers run directly in Node.
import { preservedTopics, schema5Migrations } from '../scripts/migration-contract.mjs';

const sha = 'a'.repeat(40);
const expected = identity('17', sha);
const event = {
  action: 'closed', repository: { full_name: repository },
  pull_request: { number: 7, merged: true, merge_commit_sha: sha,
    base: { ref: 'main', repo: { full_name: repository } },
    html_url: `https://github.com/${repository}/pull/7`,
    title: 'literal $(do-not-execute) `title`', body: 'Full PR body\nwith multiple lines and ${DATA}.' },
};
const moduleProduct = {
  kind: 'module', id: 'assistant', hostApi: { min: 1, max: 1 },
  requiresCapabilities: [], requiredIntents: [], databases: [], migrations: [],
};

function fixture() {
  const directory = mkdtempSync(resolve('.release-test-'));
  const stage = join(directory, 'stage');
  mkdirSync(stage);
  const descriptor = { ...expected, product: moduleProduct };
  for (const [name, value] of Object.entries({
    'package.json': { version: expected.version },
    'cockpit.module.json': { version: expected.version },
    'module-build.json': { version: expected.version, sourceSha: sha, sdk: '0.15.0', platform: 'linux', node: '24.20.0' },
    'cockpit-deployment.json': descriptor,
  })) writeFileSync(join(stage, name), `${JSON.stringify(value)}\n`);
  writeFileSync(join(directory, 'cockpit-deployment.json'), readFileSync(join(stage, 'cockpit-deployment.json')));
  execFileSync('tar', ['-czf', join(directory, expected.archive.name), '-C', stage, '.']);
  for (const name of [expected.archive.name, 'cockpit-deployment.json']) {
    writeFileSync(join(directory, `${name}.sha256`), `${hash(readFileSync(join(directory, name)))}  ${name}\n`);
  }
  return { directory, close: () => rmSync(directory, { recursive: true, force: true }) };
}

type Asset = { id: number; name: string; size: number; digest: string; state: string };
type Release = { id: number; assets: Asset[]; draft: boolean; prerelease: boolean; body: string; [key: string]: unknown };
function mock() {
  let tag: string | null = null;
  let release: Release | null = null;
  let failure: string | null = null;
  let downloaded = 0;
  const writes: string[] = [];
  const binary = new Map<number, Buffer>();
  return {
    writes, binary,
    get release() { return release!; },
    get downloaded() { return downloaded; },
    fail(path: string) { failure = path; },
    moveTag() { tag = 'b'.repeat(40); },
    async list(path: string) {
      if (path === '/releases') return release ? [structuredClone(release)] : [];
      assert.equal(path, `/releases/${release?.id}/assets`);
      return structuredClone(release!.assets);
    },
    async read(path: string, bytes = false) {
      if (path.startsWith('/git/ref/tags/')) return tag ? { object: { type: 'commit', sha: tag } } : null;
      if (bytes) {
        downloaded++;
        return binary.get(Number(path.split('/').at(-1)));
      }
      assert.equal(path, `/releases/${release?.id}`);
      return structuredClone(release);
    },
    async write(path: string, data: any, method: string, bytes = false) {
      writes.push(`${method} ${path}`);
      if (failure === path) throw new Error('lost response');
      if (path === '/git/refs') { tag = data.sha; return {}; }
      if (path === '/releases') {
        release = { ...data, id: 41, assets: [] };
        return structuredClone(release);
      }
      if (bytes) {
        const name = new URL(`https://example.invalid${path}`).searchParams.get('name')!;
        const id = 101 + release!.assets.length;
        const asset = { id, name, size: data.length, digest: `sha256:${hash(data)}`, state: 'uploaded' };
        release!.assets.push(asset);
        binary.set(id, data);
        return structuredClone(asset);
      }
      assert.equal(method, 'PATCH');
      assert.equal(path, '/releases/41');
      Object.assign(release!, data);
      return structuredClone(release);
    },
  };
}

test('Rolling identity is unique, immutable and module-specific', () => {
  assert.equal(expected.archive.name, 'cockpit-assistant-0.0.0-rolling.17.tgz');
  assert.equal(expected.tag, 'v0.0.0-rolling.17');
  for (const sequence of ['0', '-1', '01', '1.2', '9007199254740992', '1;echo nope']) {
    assert.throws(() => identity(sequence, sha));
  }
  assert.throws(() => identity(1, 'HEAD'));
});

test('Only actual accepted main merges in the intended repository qualify', () => {
  assert.equal(checkEvent(event, sha).title, event.pull_request.title);
  for (const patch of [{ merged: false }, { merge_commit_sha: 'b'.repeat(40) },
    { base: { ref: 'feature', repo: { full_name: repository } } },
    { html_url: 'https://example.invalid' }]) {
    assert.throws(() => checkEvent({ ...event, pull_request: { ...event.pull_request, ...patch } }, sha));
  }
  assert.throws(() => checkEvent({ ...event, action: 'opened' }, sha));
  assert.throws(() => checkEvent({ ...event, repository: { full_name: 'someone/fork' } }, sha));
});

test('descriptor declares native-only capabilities and explicit preserved-history upgrades', async () => {
  const actual = await product(resolve('.'));
  assert.equal(actual.id, 'assistant');
  for (const capability of ['frontend-api.v3', 'publicComponents.v1', 'conversationPresentation.v1', 'draftOwner.v1', 'draftSubmission.v2']) {
    assert.ok(!actual.requiresCapabilities.includes(capability));
  }
  assert.ok(actual.requiresCapabilities.includes('chatRead.v1'));
  assert.ok(actual.requiresCapabilities.includes('shutdown.v1'));
  assert.ok(actual.requiresCapabilities.includes('promptReceipt.v1'));
  assert.ok(actual.requiresCapabilities.includes('toolScope.v1'));
  assert.ok(actual.requiresCapabilities.includes('roleResourcePolicy.v1'));
  assert.ok(actual.requiresCapabilities.includes('roleAvailability.v1'));
  assert.ok(actual.requiresCapabilities.includes('promptOrigin.v1'));
  assert.ok(actual.requiredIntents.includes('session/chat'));
  assert.ok(actual.requiredIntents.includes('roles/availability'));
  assert.ok(!actual.requiredIntents.includes('session/resources-prepare'));
  assert.ok(actual.requiredIntents.includes('respondAsk'));
  assert.deepEqual(actual.migrations, schema5Migrations);
  assert.equal(actual.migrations.length, 1, 'The deployer accepts one automatic source per database');
  assert.equal(actual.migrations[0].from, 4);
  assert.equal(actual.migrations[0].to, 5);
  assert.equal(actual.migrations[0].database, 'assistant.sqlite');
  assert.throws(() => assertMigrationTargets({
    ...actual, migrations: [...actual.migrations, { ...actual.migrations[0], from: 3 }],
  }), /one automatic migration/);
  assert.throws(() => assertMigrationTargets({
    ...actual, migrations: [{ ...actual.migrations[0], to: 6 }],
  }), /declared final schema/);
  assert.throws(() => assertMigrationTargets({
    ...actual, migrations: [{ ...actual.migrations[0], database: 'missing.sqlite' }],
  }), /declared final schema/);
  assert.equal(actual.databases[0].path, 'assistant.sqlite');
  assert.equal(actual.databases[0].schema, 5);
  assert.deepEqual(actual.databases[0].preserve, preservedTopics());
  assert.deepEqual(actual.databases[0].preserve.map((entry: { table: string }) => entry.table),
    ['topics']);
});

test('Checksums, embedded descriptor and archive identity must all agree', () => {
  const f = fixture();
  try {
    verifyAssets(f.directory, expected, moduleProduct);
    assert.throws(() => verifyAssets(f.directory, identity(18, sha)));
    writeFileSync(join(f.directory, 'cockpit-deployment.json'), '{}');
    assert.throws(() => verifyAssets(f.directory, expected));
  } finally { f.close(); }
});

test('Publisher seals four assets, publishes once without Latest and reruns read-only', async () => {
  const f = fixture();
  const api = mock();
  try {
    const result = await publish(api, event, 17, sha, f.directory);
    assert.equal(api.release.draft, false);
    assert.equal(api.release.prerelease, true);
    assert.equal(api.release.make_latest, 'false');
    assert.ok(api.release.body.startsWith(`${event.pull_request.title}\n\n${event.pull_request.body}`));
    assert.deepEqual(result.assets.map((asset: Asset) => asset.name).sort(), assetNames(expected).sort());
    assert.equal(api.writes.filter(write => write.startsWith('PATCH')).length, 1);
    assert.equal(api.downloaded, 8);
    const before = [...api.writes];
    assert.deepEqual(await publish(api, event, 17, sha, f.directory), result);
    assert.deepEqual(api.writes, before);
    api.release.body = api.release.body.replace(event.pull_request.title, 'Changed title');
    await assert.rejects(publish(api, event, 17, sha, f.directory), /notes changed/);
    assert.deepEqual(api.writes, before);
  } finally { f.close(); }
});

test('Changed asset identities, digests and tags are rejected without replacement', async () => {
  const f = fixture();
  const api = mock();
  try {
    await publish(api, event, 17, sha, f.directory);
    const before = [...api.writes];
    api.release.assets[0]!.id++;
    await assert.rejects(publish(api, event, 17, sha, f.directory));
    api.release.assets[0]!.id--;
    api.binary.set(api.release.assets[0]!.id, Buffer.from('tampered'));
    await assert.rejects(publish(api, event, 17, sha, f.directory));
    api.moveTag();
    await assert.rejects(publish(api, event, 17, sha, f.directory));
    assert.deepEqual(api.writes, before);
  } finally { f.close(); }
});

test('Uncertain upload stops subsequent writes and existing draft reruns fail closed', async () => {
  const f = fixture();
  const api = mock();
  try {
    api.fail(`/releases/41/assets?name=${expected.archive.name}`);
    await assert.rejects(publish(api, event, 17, sha, f.directory), /outcome uncertain/);
    assert.equal(api.writes.length, 3);
    const before = [...api.writes];
    await assert.rejects(publish(api, event, 17, sha, f.directory), /Existing drafts/);
    assert.deepEqual(api.writes, before);
  } finally { f.close(); }
});

test('Uncertain tag creation and publication are never automatically retried', async () => {
  for (const path of ['/git/refs', '/releases', '/releases/41']) {
    const f = fixture();
    const api = mock();
    try {
      api.fail(path);
      await assert.rejects(publish(api, event, 17, sha, f.directory), /outcome uncertain/);
      assert.equal(api.writes.filter(write => write.endsWith(` ${path}`)).length, 1);
      assert.equal(api.writes.at(-1), `${path === '/releases/41' ? 'PATCH' : 'POST'} ${path}`);
    } finally { f.close(); }
  }
});

test('Snapshots reject unexpected assets and identity substitutions', () => {
  assert.throws(() => snapshot({ id: 1, tag_name: expected.tag, target_commitish: sha,
    name: `Cockpit Assistant ${expected.tag}`, body: '', assets: [] }, expected));
});

test('Workflow covers every merged PR, pins checkout and has no shared queue', () => {
  const workflow = readFileSync('.github/workflows/rolling.yml', 'utf8');
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /types: \[closed\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /github\.event\.pull_request\.merged == true/);
  assert.match(workflow, /source_sha: \$\{\{ github.event.pull_request.merge_commit_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /^\s*(paths|paths-ignore|concurrency):/m);
  assert.doesNotMatch(workflow, /pull_request\.(title|body|head)/);
});

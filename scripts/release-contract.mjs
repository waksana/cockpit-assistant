import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applicationTables, schemaVersion } from './schema-preflight.mjs';
import { preservedTopics, schema5Migrations } from './migration-contract.mjs';

export const repository = 'waksana/cockpit-assistant';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function identity(sequence, sourceSha) {
  assert.match(String(sequence), /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(Number(sequence)));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const version = `0.0.0-rolling.${sequence}`;
  return { format: 2, channel: 'rolling', repository, tag: `v${version}`, sourceSha,
    version, sequence: Number(sequence), archive: { name: `cockpit-assistant-${version}.tgz` } };
}
export const assetNames = expected => [expected.archive.name, `${expected.archive.name}.sha256`,
  'cockpit-deployment.json', 'cockpit-deployment.json.sha256'];

export function checkEvent(event, sourceSha) {
  assert.equal(event.action, 'closed');
  assert.equal(event.repository.full_name, repository);
  const pr = event.pull_request;
  assert.equal(pr.merged, true);
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.base.repo.full_name, repository);
  assert.equal(pr.merge_commit_sha, sourceSha);
  assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0);
  assert.equal(pr.html_url, `https://github.com/${repository}/pull/${pr.number}`);
  assert.equal(typeof pr.title, 'string');
  assert.ok(pr.body === null || typeof pr.body === 'string');
  return pr;
}

export async function product(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  assert.equal(manifest.id, 'assistant');
  assert.equal(manifest.apiVersion, 1);
  const sources = Object.fromEntries(['src/index.ts']
    .map(name => [name, readFileSync(join(root, name), 'utf8')]));
  const hostSources = readdirSync(join(root, 'src')).filter(name => name.endsWith('.ts'))
    .map(name => readFileSync(join(root, 'src', name), 'utf8'));
  for (const [file, gate] of [
    ['src/index.ts', 'context.serviceReadyVersion === 1'],
    ...['chatRead', 'askResponse', 'roleAssignment', 'sessionLoad', 'promptReceipt', 'toolScope',
      'roleResourcePolicy', 'promptOrigin'].map(name => ['src/index.ts', `host.${name}Version === 1`]),
  ]) assert.ok(sources[file].includes(gate), `Review changed capability gate: ${gate}`);
  assert.ok(sources['src/index.ts'].includes("'assistant.sqlite'"), 'Review changed database path');
  const { Store } = await import(new URL('../src/store.ts', import.meta.url));
  const db = new Store(':memory:');
  try {
    const schema = db.sql.prepare('PRAGMA user_version').get().user_version;
    assert.equal(schema, schemaVersion, 'Review schema changes and the explicit preservation/migration contract');
    const tables = db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(({ name }) => name);
    assert.deepEqual(tables, applicationTables, 'The released database must match the declared foreground schema');
    return {
      kind: 'module', id: manifest.id, hostApi: { min: 1, max: 1 },
      requiresCapabilities: ['module-api.v1', 'serviceReady.v1', 'chatRead.v1', 'askResponse.v1',
        'roleAssignment.v1', 'sessionLoad.v1', 'promptReceipt.v1', 'toolScope.v1', 'roleResourcePolicy.v1', 'promptOrigin.v1'],
      requiredIntents: [...new Set(hostSources.flatMap(source =>
        [...source.matchAll(/host\.call\('([^']+)'/g)].map(match => match[1])))].sort(),
      databases: [{ path: 'assistant.sqlite', schema, preserve: preservedTopics() }],
      migrations: schema5Migrations,
    };
  } finally { db.close(); }
}

export function verifyAssets(directory, expected, expectedProduct) {
  const bytes = Object.fromEntries(assetNames(expected).map(name => [name, readFileSync(join(directory, name))]));
  for (const name of [expected.archive.name, 'cockpit-deployment.json']) {
    assert.equal(bytes[`${name}.sha256`].toString(), `${hash(bytes[name])}  ${name}\n`);
  }
  const descriptor = JSON.parse(bytes['cockpit-deployment.json']);
  const { product: actualProduct, ...actualIdentity } = descriptor;
  assert.deepEqual(actualIdentity, expected);
  assert.equal(actualProduct.kind, 'module');
  assert.equal(actualProduct.id, 'assistant');
  assert.deepEqual(actualProduct.hostApi, { min: 1, max: 1 });
  for (const key of ['requiresCapabilities', 'requiredIntents', 'databases', 'migrations']) {
    assert.ok(Array.isArray(actualProduct[key]));
  }
  if (expectedProduct) assert.deepEqual(actualProduct, expectedProduct);
  const archive = join(directory, expected.archive.name);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n');
  assert.equal(new Set(entries).size, entries.length);
  assert.ok(entries.every(name => name.startsWith('./') && !name.includes('\\') && !name.split('/').includes('..')));
  const extract = name => execFileSync('tar', ['-xOzf', archive, `./${name}`], { maxBuffer: 32 * 1024 * 1024 });
  assert.deepEqual(extract('cockpit-deployment.json'), bytes['cockpit-deployment.json']);
  for (const name of ['package.json', 'cockpit.module.json', 'module-build.json']) {
    const value = JSON.parse(extract(name));
    assert.equal(value.version, expected.version);
    if (name === 'module-build.json') {
      assert.equal(value.sourceSha, expected.sourceSha);
      assert.equal(value.sdk, '0.12.0');
      assert.equal(value.platform, 'linux');
      assert.match(value.node, /^24\./);
    }
  }
  return bytes;
}

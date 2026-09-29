import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const sources = Object.fromEntries(['src/index.ts', 'src/native.ts', 'src/runtime.ts', 'frontend/index.ts']
    .map(name => [name, readFileSync(join(root, name), 'utf8')]));
  for (const [file, gate] of [
    ['src/index.ts', 'context.serviceReadyVersion === 1'],
    ['src/native.ts', 'host.chatReadVersion === 1'],
    ['src/native.ts', 'host.askResponseVersion === 1'],
    ['src/native.ts', 'host.resourcePreparationVersion === 1'],
    ['src/native.ts', 'host.roleAssignmentVersion === 1'],
    ['src/native.ts', 'host.sessionDirectoryVersion === 1'],
    ['src/native.ts', 'host.sessionLoadVersion === 1'],
    ['frontend/index.ts', 'context.apiVersion !== 3'],
    ['frontend/index.ts', 'context.publicComponentsVersion !== 1'],
    ['frontend/index.ts', 'context.draftOwnerVersion !== 1'],
    ['frontend/index.ts', 'context.draftSubmissionVersion !== 2'],
    ['frontend/index.ts', 'context.globalComponentVersion !== 1'],
    ['frontend/index.ts', 'context.menuVersion !== 1'],
    ['frontend/index.ts', 'context.uiVersion !== 1'],
    ['frontend/index.ts', 'context.uiSurfaceVersion !== 1'],
  ]) assert.ok(sources[file].includes(gate), `Review changed capability gate: ${gate}`);
  assert.ok(sources['src/index.ts'].includes("'assistant.sqlite'"), 'Review changed database path');
  const { Database } = await import(new URL('../src/database.ts', import.meta.url));
  const db = new Database(':memory:');
  try {
    const schema = db.sql.prepare('PRAGMA user_version').get().user_version;
    assert.equal(schema, 1, 'Review schema changes; no automatic migration is declared');
    const preserve = db.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(({ name }) => {
        assert.match(name, /^[a-z_]+$/);
        return { table: name, columns: db.sql.prepare(`PRAGMA table_info("${name}")`).all().map(row => row.name) };
      });
    return {
      kind: 'module', id: manifest.id, hostApi: { min: 1, max: 1 },
      requiresCapabilities: ['module-api.v1', 'serviceReady.v1', 'chatRead.v1', 'askResponse.v1',
        'resourcePreparation.v1', 'roleAssignment.v1', 'sessionDirectory.v1', 'sessionLoad.v1',
        'frontend-api.v3', 'publicComponents.v1', 'draftOwner.v1', 'draftSubmission.v2',
        'globalComponent.v1', 'menu.v1', 'ui.v1', 'uiSurface.v1'],
      requiredIntents: [...new Set(Object.values(sources).flatMap(source =>
        [...source.matchAll(/host\.call\('([^']+)'/g)].map(match => match[1])))].sort(),
      databases: [{ path: 'assistant.sqlite', schema, preserve }], migrations: [],
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
      assert.equal(value.sdk, '0.7.0');
      assert.equal(value.platform, 'linux');
      assert.match(value.node, /^24\./);
    }
  }
  return bytes;
}

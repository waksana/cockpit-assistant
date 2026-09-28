import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repository, identity, checkEvent, assetNames, hash, verifyAssets } from './release-contract.mjs';

const marker = '\n\n<!-- cockpit-rolling-publication\n';
const seal = snapshot => `${marker}${JSON.stringify(snapshot)}\n-->\n`;
const notesFor = (pr, expected, bytes) =>
  `${pr.title}\n\n${pr.body ?? ''}\n\n---\nPR: ${pr.html_url}\nSource: ${expected.sourceSha}\nTag: ${expected.tag}\nVersion: ${expected.version}\nSequence: ${expected.sequence}\n\n${assetNames(expected).map(name => `- ${name}: sha256:${hash(bytes[name])}`).join('\n')}\n`;

export function client(token = process.env.GH_TOKEN) {
  assert.ok(token, 'GH_TOKEN required');
  const request = async (path, method, data, binary = false) => {
    const writing = method !== 'GET';
    const response = await fetch(`https://${writing && binary ? 'uploads' : 'api'}.github.com/repos/${repository}${path}`, {
      method, redirect: writing ? 'error' : 'follow',
      headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
        Accept: binary && !writing ? 'application/octet-stream' : 'application/vnd.github+json',
        ...(writing ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(writing ? { body: binary ? data : JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(120000),
    });
    if (!writing && !binary && response.status === 404) return null;
    assert.ok(response.ok, `GitHub ${method} failed: ${response.status}`);
    return binary && !writing ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  return {
    read: (path, binary = false) => request(path, 'GET', undefined, binary),
    write: (path, data, method = 'POST', binary = false) => request(path, method, data, binary),
    async list(path) {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await request(`${path}?per_page=100&page=${page}`, 'GET');
        assert.ok(Array.isArray(batch));
        all.push(...batch);
        if (batch.length < 100) return all;
      }
    },
  };
}

export async function verifySource(api, event, sourceSha, root = process.cwd()) {
  identity(1, sourceSha);
  const pr = checkEvent(event, sourceSha);
  const current = await api.read(`/pulls/${pr.number}`);
  assert.ok(current);
  checkEvent({ ...event, pull_request: current }, sourceSha);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sourceSha, 'Checkout must be the accepted merge, never PR head');
  git('merge-base', '--is-ancestor', sourceSha, 'refs/remotes/origin/main');
}

export function snapshot(release, expected) {
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(release.tag_name, expected.tag);
  assert.equal(release.target_commitish, expected.sourceSha);
  assert.equal(release.name, `Cockpit Assistant ${expected.tag}`);
  assert.equal(typeof release.body, 'string');
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), assetNames(expected).sort());
  const assets = release.assets.map(asset => {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
    assert.equal(asset.state, 'uploaded');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
    return { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest };
  }).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(new Set(assets.map(asset => asset.id)).size, 4);
  return { id: release.id, tag: expected.tag, sourceSha: expected.sourceSha, name: release.name, assets };
}

async function tagSha(api, tag) {
  const ref = await api.read(`/git/ref/tags/${tag}`);
  if (!ref) return null;
  assert.equal(ref.object.type, 'commit', 'Rolling tags are immutable lightweight commit refs');
  return ref.object.sha;
}
async function find(api, tag) {
  const matches = (await api.list('/releases')).filter(release => release.tag_name === tag);
  assert.ok(matches.length <= 1, 'Duplicate exact-tag releases');
  return matches[0] ?? null;
}
async function readRelease(api, id) {
  const release = await api.read(`/releases/${id}`);
  assert.equal(release?.id, id);
  return { ...release, assets: await api.list(`/releases/${id}/assets`) };
}

export async function verifyRemote(api, id, expected, directory, sealed = true) {
  assert.equal(await tagSha(api, expected.tag), expected.sourceSha);
  const release = await readRelease(api, id);
  const state = snapshot(release, expected);
  if (sealed) {
    const start = release.body.lastIndexOf(marker);
    assert.ok(start >= 0, 'Missing original asset identity seal');
    assert.equal(release.body.slice(start), seal(state), 'Original release/asset identity changed');
  }
  mkdirSync(directory);
  try {
    for (const asset of state.assets) {
      const bytes = await api.read(`/releases/assets/${asset.id}`, true);
      assert.equal(bytes.length, asset.size);
      assert.equal(`sha256:${hash(bytes)}`, asset.digest);
      writeFileSync(join(directory, asset.name), bytes);
    }
    const bytes = verifyAssets(directory, expected);
    const after = await readRelease(api, id);
    assert.deepEqual(snapshot(after, expected), state, 'Release identity changed during verification');
    for (const key of ['body', 'draft', 'prerelease']) assert.equal(after[key], release[key]);
    assert.equal(await tagSha(api, expected.tag), expected.sourceSha);
    return { release, state, bytes };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// Never retry a mutation after a timeout or lost acknowledgement.
async function mutate(api, path, data, method, binary, observe) {
  try { return await api.write(path, data, method, binary); }
  catch (error) {
    try {
      const observed = await observe();
      console.error('Write readback:', JSON.stringify(observed));
    } catch (readError) { console.error('Readback unavailable:', readError.message); }
    throw new Error(`Write outcome uncertain; inspect remote state before any recovery: ${error.message}`);
  }
}

export async function publish(api, event, sequence, sourceSha, directory = 'release-artifacts') {
  const pr = checkEvent(event, sourceSha);
  const expected = identity(sequence, sourceSha);
  const existing = await find(api, expected.tag);
  if (existing) {
    assert.equal(existing.draft, false, 'Existing drafts require separately authorized inspection; never repair automatically');
    const verified = await verifyRemote(api, existing.id, expected, join(directory, 'rerun-verification'));
    assert.equal(verified.release.draft, false);
    assert.equal(verified.release.body, notesFor(pr, expected, verified.bytes) + seal(verified.state),
      'Original triggering PR notes changed');
    // Existing immutable bytes are authoritative even if a later runner has a newer Node patch.
    return verified.state;
  }
  const bytes = verifyAssets(directory, expected);
  const notes = notesFor(pr, expected, bytes);
  const tag = await tagSha(api, expected.tag);
  if (tag) assert.equal(tag, sourceSha, 'Tag cannot move');
  else await mutate(api, '/git/refs', { ref: `refs/tags/${expected.tag}`, sha: sourceSha }, 'POST', false,
    () => tagSha(api, expected.tag));
  assert.equal(await tagSha(api, expected.tag), sourceSha);
  const created = await mutate(api, '/releases', { tag_name: expected.tag, target_commitish: sourceSha,
    name: `Cockpit Assistant ${expected.tag}`, body: notes, draft: true, prerelease: true, make_latest: 'false' },
  'POST', false, () => find(api, expected.tag));
  assert.ok(Number.isSafeInteger(created.id) && created.id > 0);
  const draft = await readRelease(api, created.id);
  assert.equal(draft.tag_name, expected.tag);
  assert.equal(draft.target_commitish, sourceSha);
  assert.equal(draft.name, `Cockpit Assistant ${expected.tag}`);
  assert.equal(draft.body, notes);
  assert.equal(draft.draft, true);
  assert.equal(draft.prerelease, true);
  assert.deepEqual(draft.assets, []);
  for (const name of assetNames(expected)) {
    const current = await readRelease(api, created.id);
    assert.equal(current.draft, true);
    assert.equal(current.tag_name, expected.tag);
    assert.equal(current.target_commitish, sourceSha);
    assert.equal(current.body, notes);
    await mutate(api, `/releases/${created.id}/assets?name=${encodeURIComponent(name)}`, bytes[name], 'POST', true,
      () => readRelease(api, created.id));
  }
  const verified = await verifyRemote(api, created.id, expected, join(directory, 'draft-verification'), false);
  assert.equal(verified.release.draft, true);
  assert.equal(verified.release.prerelease, true);
  assert.equal(verified.release.body, notes);
  for (const name of assetNames(expected)) assert.deepEqual(verified.bytes[name], bytes[name]);
  const body = notes + seal(verified.state);
  // Publish and seal together: a body-only draft PATCH can change GitHub's tag selection.
  await mutate(api, `/releases/${created.id}`, { body, draft: false, prerelease: true, make_latest: 'false' },
    'PATCH', false, () => readRelease(api, created.id));
  const final = await verifyRemote(api, created.id, expected, join(directory, 'published-verification'));
  assert.deepEqual(final.state, verified.state);
  assert.equal(final.release.body, body);
  assert.equal(final.release.draft, false);
  assert.equal(final.release.prerelease, true);
  return final.state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request_target');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const api = client();
  await verifySource(api, event, process.env.SOURCE_SHA);
  if (process.argv[2] === 'publish') {
    await publish(api, event, process.env.ROLLING_SEQUENCE, process.env.SOURCE_SHA);
  } else assert.equal(process.argv[2], 'source');
}

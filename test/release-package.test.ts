import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
// @ts-expect-error Release helpers are native ESM outside the runtime build.
import { packageRelease } from '../scripts/release-package.mjs';
// @ts-expect-error Release helpers are native ESM outside the runtime build.
import { assetNames, identity, verifyAssets } from '../scripts/release-contract.mjs';
// @ts-expect-error Packaging helpers are native ESM outside the runtime build.
import { buildRoleInstructions } from '../scripts/role-instructions.mjs';

test('actual Rolling packager emits a native-only package without changing tracked source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-rolling-package-'));
  try {
    const tracked = ['package.json', 'package-lock.json', 'cockpit.module.json', 'README.md', 'src', 'roles', 'skills', 'docs'];
    for (const path of tracked) cpSync(resolve(path), join(root, path), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
    assert.equal(manifest.frontend, undefined);
    await buildRoleInstructions(root);
    for (const [entry, output] of [['src/index.ts', manifest.backend], ['scripts/migrate-entry.mjs', 'dist/migrate.js']]) {
      await build({ entryPoints: [resolve(entry)], outfile: join(root, output),
        platform: 'node', format: 'esm', target: 'node24', bundle: true });
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('add', '--', ...tracked);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'Synthetic release fixture',
      '-m', 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>');
    const sha = git('rev-parse', 'HEAD'), expected = identity(17, sha);
    const descriptor = await packageRelease(root, 17, sha, 'release-candidate');
    const output = join(root, 'release-candidate');
    assert.deepEqual(readdirSync(output).sort(), assetNames(expected).sort());
    verifyAssets(output, expected, descriptor.product);
    assert.equal(descriptor.product.databases[0].schema, 5);
    const archive = join(output, expected.archive.name);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(entries.includes(`./${manifest.backend}`));
    assert.ok(entries.includes('./dist/migrate.js'));
    assert.equal(entries.some(entry => entry.startsWith('./dist/web/')), false);
    const packed = JSON.parse(execFileSync('tar', ['-xOzf', archive, './cockpit.module.json'], { encoding: 'utf8' }));
    assert.equal(packed.frontend, undefined);
    assert.equal(packed.version, expected.version);
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.0-dev');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

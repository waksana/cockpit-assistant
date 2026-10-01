import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity, product, hash, verifyAssets } from './release-contract.mjs';

export async function packageRelease(root, sequence, sourceSha, output = 'release-artifacts') {
  const expected = identity(sequence, sourceSha);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sourceSha);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Tracked source must be clean');
  assert.equal(process.platform, 'linux');
  assert.match(process.versions.node, /^24\./);
  assert.match(output, /^[a-z][a-z0-9-]*$/);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  for (const version of [pkg.version, manifest.version, lock.version, lock.packages[''].version]) {
    assert.equal(version, '0.0.0-dev', 'Source manifests keep the development version');
  }
  assert.equal(pkg.devDependencies['@waksana/cockpit-module-sdk'], '0.13.0');
  const descriptor = { ...expected, product: await product(root) };
  const directory = resolve(root, output);
  mkdirSync(directory);
  const scratch = mkdtempSync(join(root, '.release-stage-'));
  try {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch],
      { cwd: root, encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', join(scratch, pack.filename), '-C', scratch]);
    const stage = join(scratch, 'package');
    const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    json(join(stage, 'package.json'), { ...pkg, version: expected.version });
    json(join(stage, 'cockpit.module.json'), { ...manifest, version: expected.version });
    json(join(stage, 'module-build.json'), { format: 1, version: expected.version, sourceSha,
      node: process.versions.node, platform: process.platform, arch: process.arch, sdk: '0.13.0' });
    json(join(stage, 'cockpit-deployment.json'), descriptor);
    json(join(directory, 'cockpit-deployment.json'), descriptor);
    const archive = join(directory, expected.archive.name);
    execFileSync('tar', ['--sort=name', `--mtime=@${git('show', '-s', '--format=%ct', sourceSha)}`,
      '--owner=0', '--group=0', '--numeric-owner', '-I', 'gzip -n', '-cf', archive, '-C', stage, '.']);
    for (const name of [expected.archive.name, 'cockpit-deployment.json']) {
      writeFileSync(join(directory, `${name}.sha256`), `${hash(readFileSync(join(directory, name)))}  ${name}\n`);
    }
    verifyAssets(directory, expected, descriptor.product);
    // npm pack:check owns the isolated backend/frontend closure test in CI.
    assert.equal(typeof (await import(pathToFileURL(join(stage, manifest.backend)).href)).activate, 'function');
    assert.equal(typeof (await import(pathToFileURL(join(stage, manifest.frontend.entry)).href)).activate, 'function');
    return descriptor;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await packageRelease(process.cwd(), process.env.ROLLING_SEQUENCE, process.env.SOURCE_SHA);
}

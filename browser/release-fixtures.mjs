import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const releases = [
  { id: 'cockpit-file', version: '0.0.0-rolling.17', env: 'ASSISTANT_FILE_FIXTURE',
    buildHash: 'd40e31bfdecf3bd0c932b90a67cf71210a2688db3b547a9a3739dbb1ca3ec0e7' },
  { id: 'cockpit-speech', version: '0.0.0-rolling.2', env: 'ASSISTANT_SPEECH_FIXTURE',
    buildHash: '8f32a698783c86349323c128eaf415fc6cc09a8cf54f3274b08015cd16fc6793' },
];
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function prepareReleases(output) {
  const fixtures = [];
  for (const release of releases) {
    const cache = join(output, release.id);
    const root = process.env[release.env] ? resolve(process.env[release.env]) : join(cache, 'package');
    try { await access(join(root, 'module-build.json')); } catch {
      if (process.env[release.env]) throw new Error(`${release.env} is not a release package directory`);
      await mkdir(root, { recursive: true });
      const archive = `${release.id}-${release.version}.tgz`;
      execFileSync('gh', ['release', 'download', `v${release.version}`, '--repo', `waksana/${release.id}`,
        '--pattern', archive, '--dir', cache, '--clobber'], { stdio: 'pipe' });
      execFileSync('tar', ['-xzf', join(cache, archive), '-C', root,
        'module-build.json', 'cockpit.module.json', 'dist/web', 'dist/shared']);
    }
    const build = await readFile(join(root, 'module-build.json'));
    if (sha256(build) !== release.buildHash) throw new Error(`Unrecognized ${release.id} release build identity`);
    const identity = JSON.parse(build.toString());
    if (identity.product !== release.id || identity.version !== release.version) throw new Error('Release identity mismatch');
    const assets = {};
    for (const file of identity.files) {
      if (!(file.path.startsWith('dist/web/') || file.path.startsWith('dist/shared/')
        || file.path === 'cockpit.module.json')) continue;
      if (file.path.includes('..')) throw new Error('Invalid release asset path');
      const path = join(root, file.path);
      const bytes = await readFile(path);
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error(`Modified release asset: ${path}`);
      assets[file.path] = path;
    }
    const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
    fixtures.push({ id: release.id, version: release.version, digest: release.buildHash, assets,
      entry: manifest.frontend.entry, styles: manifest.frontend.styles, sourceSha: identity.sourceSha });
  }
  await writeFile(join(output, 'real-modules.json'), JSON.stringify(fixtures));
  console.log(`Verified release fixtures: ${fixtures.map(value => `${value.id}@${value.version}`).join(', ')}`);
}

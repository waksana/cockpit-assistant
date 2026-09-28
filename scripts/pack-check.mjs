import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'assistant-pack-'));
try {
  const manifest = JSON.parse(await readFile('cockpit.module.json', 'utf8'));
  assert.equal(manifest.frontend.entry, 'dist/web/index.js');
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { encoding: 'utf8' }));
  const files = new Set(pack.files.map(file => file.path));
  for (const path of [manifest.backend, manifest.frontend.entry, ...manifest.frontend.styles,
    'cockpit.module.json', 'README.md', 'licenses/lucide.txt', ...manifest.roles.map(role => role.instructions)]) {
    assert.ok(files.has(path), `Missing packaged file ${path}`);
  }
  assert.ok(![...files].some(path => path.startsWith('src/') || path.startsWith('node_modules/') || path.includes('.sqlite')));
  execFileSync('tar', ['-xzf', join(temporary, pack.filename), '-C', temporary]);
  const backend = await import(pathToFileURL(join(temporary, 'package', manifest.backend)).href);
  assert.equal(typeof backend.activate, 'function');
  const frontend = await import(pathToFileURL(join(temporary, 'package', manifest.frontend.entry)).href);
  assert.equal(typeof frontend.activate, 'function');
  console.log(`Pack closure verified: ${pack.filename}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

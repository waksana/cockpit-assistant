import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySchemaBoundary } from './schema-preflight.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'assistant-pack-'));
try {
  const manifest = JSON.parse(await readFile('cockpit.module.json', 'utf8'));
  assert.equal(manifest.frontend, undefined);
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { encoding: 'utf8' }));
  const files = new Set(pack.files.map(file => file.path));
  for (const path of [manifest.backend,
    'cockpit.module.json', 'README.md', 'dist/migrate.js',
    'skills/assistant-topics/SKILL.md', ...manifest.roles.map(role => role.instructions)]) {
    assert.ok(files.has(path), `Missing packaged file ${path}`);
  }
  assert.ok(![...files].some(path => path.startsWith('src/') || path.startsWith('node_modules/') || path.startsWith('dist/web/') || path.includes('.sqlite')));
  execFileSync('tar', ['-xzf', join(temporary, pack.filename), '-C', temporary]);
  const backend = await import(pathToFileURL(join(temporary, 'package', manifest.backend)).href);
  assert.equal(typeof backend.activate, 'function');
  const skill = (await readFile(join(temporary, 'package/skills/assistant-topics/SKILL.md'), 'utf8'))
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  for (const role of manifest.roles.filter(role => role.id === 'coordinator' || role.id === 'organizer')) {
    const instructions = await readFile(join(temporary, 'package', role.instructions), 'utf8');
    assert.ok(instructions.endsWith(`${skill}\n`), `Packaged ${role.id} must include the actual shared Skill body`);
  }
  await verifySchemaBoundary(backend.activate, temporary, join(temporary, 'package/dist/migrate.js'));
  console.log(`Pack closure verified: ${pack.filename}`);
  console.log('Packaged migration retains schema 3/4 archives and moves unread entries into the minimal schema 5');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

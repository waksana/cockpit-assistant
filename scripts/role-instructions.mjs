import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildRoleInstructions(root = process.cwd()) {
  const skill = (await readFile(join(root, 'skills/assistant-topics/SKILL.md'), 'utf8'))
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  if (!skill) throw new Error('Session conversation Skill body is empty');
  await mkdir(join(root, 'dist/roles'), { recursive: true });
  await rm(join(root, 'dist/roles/organizer.md'), { force: true });
  for (const role of ['coordinator']) {
    const identity = (await readFile(join(root, `roles/${role}.md`), 'utf8')).trim();
    if (!identity) throw new Error(`Role identity is empty: ${role}`);
    await writeFile(join(root, `dist/roles/${role}.md`), `${identity}\n\n${skill}\n`);
  }
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildRoleInstructions(root = process.cwd()) {
  const skill = (await readFile(join(root, 'skills/assistant-topics/SKILL.md'), 'utf8'))
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  if (!skill) throw new Error('Topic management Skill body is empty');
  await mkdir(join(root, 'dist/roles'), { recursive: true });
  for (const role of ['coordinator', 'organizer']) {
    const identity = (await readFile(join(root, `roles/${role}.md`), 'utf8')).trim();
    if (!identity) throw new Error(`Role identity is empty: ${role}`);
    await writeFile(join(root, `dist/roles/${role}.md`), `${identity}\n\n${skill}\n`);
  }
}

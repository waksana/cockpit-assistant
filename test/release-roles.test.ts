import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Packaging helpers are native ESM scripts outside the runtime type build.
import { buildRoleInstructions } from '../scripts/role-instructions.mjs';

test('shared topic Skill is physically embedded in each role without requiring a Skill-reading tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-role-instructions-'));
  try {
    await mkdir(join(root, 'roles'));
    await mkdir(join(root, 'skills/assistant-topics'), { recursive: true });
    for (const path of ['roles/coordinator.md', 'roles/organizer.md', 'skills/assistant-topics/SKILL.md']) {
      await copyFile(path, join(root, path));
    }
    await buildRoleInstructions(root);
    const shared = (await readFile('skills/assistant-topics/SKILL.md', 'utf8'))
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    const front = await readFile(join(root, 'dist/roles/coordinator.md'), 'utf8');
    const organizer = await readFile(join(root, 'dist/roles/organizer.md'), 'utf8');
    assert.ok(front.endsWith(`${shared}\n`));
    assert.ok(organizer.endsWith(`${shared}\n`));
    assert.match(front, /continuous Assistant conversation/);
    assert.match(organizer, /not the foreground/);
    assert.match(organizer, /latest three nonempty user\/assistant messages/);
    assert.match(organizer, /`recent:true`/);
    assert.match(shared, /Do not automatically\s+read older pages/);
    assert.match(front, /Every business request\s+goes to its background session/);
    assert.match(front, /never authorizes new business\s+dispatch/);
    assert.match(front, /Do not assess business quality or completeness/);
    assert.match(front, /user's complete\s+original answer unchanged/);
    assert.match(shared, /How should the topic system be\s+designed/);
    assert.match(shared, /consumed\s+immediately/);
    assert.match(shared, /omit `topicId`/);
    assert.match(shared, /Never invent an\s+ID for dispatch/);
    const manifest = JSON.parse(await readFile('cockpit.module.json', 'utf8'));
    const role = (id: string) => manifest.roles.find((entry: { id: string }) => entry.id === id);
    assert.equal(role('coordinator').instructions, 'dist/roles/coordinator.md');
    assert.equal(role('coordinator').resourcePolicy, 'exclusive');
    assert.equal(role('organizer').resourcePolicy, 'exclusive');
    assert.equal(role('organizer').instructions, 'dist/roles/organizer.md');
    assert.ok(role('coordinator').mcpServers.assistant.tools.includes('assistant_dispatch'));
    assert.ok(!role('organizer').mcpServers.assistant.tools.includes('assistant_dispatch'));
    assert.equal(role('worker').mcpServers, undefined);
    assert.equal(manifest.instructions, undefined, 'The foreground role must not be injected into all native sessions');
    assert.equal(manifest.frontend, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

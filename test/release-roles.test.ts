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
    assert.match(organizer, /Host/);
    assert.match(shared, /Do not automatically\s+read\s+older pages/);
    assert.match(front, /Host's session and prompt tools directly/);
    assert.match(front, /never business authorization/);
    assert.match(front, /cockpit_respond_ask/);
    assert.match(front, /not proof the user saw a response/);
    assert.match(shared, /Inbox\s+listing does not\s+consume replies/);
    assert.match(shared, /never as current evidence/);
    assert.match(shared, /context loss/);
    assert.match(shared, /attention preferences take priority/);
    assert.match(shared, /assistant_resolve/);
    assert.match(shared, /omit `topicId`/);
    assert.match(shared, /never creates or dispatches/);
    const manifest = JSON.parse(await readFile('cockpit.module.json', 'utf8'));
    const role = (id: string) => manifest.roles.find((entry: { id: string }) => entry.id === id);
    assert.equal(role('coordinator').instructions, 'dist/roles/coordinator.md');
    assert.equal(role('coordinator').resourcePolicy, undefined);
    assert.equal(role('organizer').resourcePolicy, undefined);
    assert.equal(role('organizer').instructions, 'dist/roles/organizer.md');
    assert.ok(!role('coordinator').mcpServers.assistant.tools.includes('assistant_dispatch'));
    assert.ok(role('coordinator').mcpServers.assistant.tools.includes('assistant_foreground'));
    assert.ok(!role('organizer').mcpServers.assistant.tools.includes('assistant_dispatch'));
    assert.equal(role('worker'), undefined);
    assert.equal(role('coordinator').mcpServers.assistant.tools.length, 7);
    assert.ok(role('coordinator').mcpServers.assistant.tools.includes('assistant_search'));
    for (const boundary of [
      /Do not perform business reasoning or add your own solution/,
      /including questions about Assistant, its Skill or inbox/,
      /Route before investigating: read-only diagnosis is still business reasoning/,
      /Only clarify which topic or object the user means/,
      /Avoid stock openings/,
      /Waiting needs no acknowledgement or progress announcement/,
      /not mechanical relay or new business reasoning/,
      /cannot select a different session/,
      /Do not create a new session for each follow-up or a separate topic specialist/,
    ]) assert.match(front, boundary);
    assert.equal(role('organizer').mcpServers.assistant.tools.length, 2);
    assert.equal(manifest.instructions, undefined, 'The foreground role must not be injected into all native sessions');
    assert.equal(manifest.frontend, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

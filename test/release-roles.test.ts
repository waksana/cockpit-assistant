import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Packaging helpers are native ESM scripts outside the runtime type build.
import { buildRoleInstructions } from '../scripts/role-instructions.mjs';

test('session guidance is embedded only in coordinator and retires organizer without a topic prerequisite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-role-instructions-'));
  try {
    await mkdir(join(root, 'roles'));
    await mkdir(join(root, 'skills/assistant-topics'), { recursive: true });
    for (const path of ['roles/coordinator.md', 'skills/assistant-topics/SKILL.md']) {
      await copyFile(path, join(root, path));
    }
    await mkdir(join(root, 'dist/roles'), { recursive: true });
    await writeFile(join(root, 'dist/roles/organizer.md'), 'Old generated role');
    await buildRoleInstructions(root);
    const shared = (await readFile('skills/assistant-topics/SKILL.md', 'utf8'))
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    const front = await readFile(join(root, 'dist/roles/coordinator.md'), 'utf8');
    assert.ok(front.endsWith(`${shared}\n`));
    await assert.rejects(access(join(root, 'dist/roles/organizer.md')), { code: 'ENOENT' });
    assert.match(front, /continuous Assistant conversation/);
    assert.match(shared, /Do not automatically\s+read\s+older pages/);
    assert.match(front, /Host's session and prompt tools directly/);
    assert.match(front, /never business authorization/);
    assert.match(front, /cockpit_respond_ask/);
    assert.match(front, /not proof the user saw a response/);
    assert.match(shared, /Inbox\s+listing does not\s+consume replies/);
    assert.match(shared, /never current evidence/);
    assert.match(shared, /context loss/);
    assert.match(shared, /attention preferences take priority/);
    assert.match(shared, /assistant_resolve/);
    assert.match(shared, /never creates or dispatches to a business session/);
    const manifest = JSON.parse(await readFile('cockpit.module.json', 'utf8'));
    const role = (id: string) => manifest.roles.find((entry: { id: string }) => entry.id === id);
    assert.equal(role('coordinator').instructions, 'dist/roles/coordinator.md');
    assert.equal(role('coordinator').resourcePolicy, undefined);
    assert.equal(role('organizer'), undefined);
    assert.deepEqual(manifest.roles.map((entry: { id: string }) => entry.id), ['coordinator']);
    assert.ok(!role('coordinator').mcpServers.assistant.tools.includes('assistant_dispatch'));
    assert.ok(role('coordinator').mcpServers.assistant.tools.includes('assistant_foreground'));
    assert.equal(role('worker'), undefined);
    assert.equal(role('coordinator').mcpServers.assistant.tools.length, 8);
    assert.ok(role('coordinator').mcpServers.assistant.tools.includes('assistant_search'));
    assert.ok(role('coordinator').mcpServers.assistant.tools.includes('assistant_watch'));
    assert.ok(role('coordinator').mcpServers.assistant.tools.includes('assistant_watches'));
    assert.ok(!role('coordinator').mcpServers.assistant.tools.includes('assistant_topic'));
    for (const boundary of [
      /Do not perform business reasoning or add your own solution/,
      /including questions about Assistant, its Skill or inbox/,
      /Route before investigating: read-only diagnosis is still business reasoning/,
      /Only clarify the intended topic\/object, request scope or discussion-versus-execution\s+intent/,
      /Avoid stock openings/,
      /Waiting needs no acknowledgement or progress announcement/,
      /not mechanical relay or new business reasoning/,
      /cannot select a different session/,
      /Do not create a new session for each follow-up or a separate topic specialist/,
    ]) assert.match(front, boundary);
    for (const selection of [
      /A shared product name only identifies candidates/,
      /Reuse requires evidence of the\s+same specific responsibility or a continuing discussion/,
      /A topic\s+label neither defines that responsibility nor determines session reuse/,
      /A known suitable session needs no topic lookup, topic creation or directory scan/,
      /native session discovery \(`cockpit_list_sessions`\) and direct Chat\/status reads/,
      /hints are optional ways to locate candidates, not sequential\s+gates/,
      /Topic registration or maintenance is never a prerequisite/,
      /Apply relevant, available\s+responsibility-discovery capabilities and their guidance while choosing/,
      /Reuse sufficient\s+evidence already read and still current/,
      /Do not exclude a clearly relevant candidate merely because its recent snippet\s+covers a different subtask/,
      /material candidate conflicts are resolved, not just when one lookup returns a\s+match/,
      /After a scope correction, reconsider relevant candidates rather than only\s+validating the first recipient/,
      /a current subtask or quiet period\s+does not by itself narrow or end an agreement/,
      /recent work goal and\s+phase in native Chat, alongside current Host activity and queues/,
      /Neither `running`, elapsed time nor shell count alone establishes heavy/,
      /unknown\s+activity is not idle/,
      /Independent questions must not default to the queue/,
      /Prefer a matching\s+existing discussion session/,
      /Only when necessary lookup finds none suitable,\s+create an ordinary session with a specific discussion goal/,
      /Corrections, constraints, materials and question answers required by current\s+execution still belong to the executing session/,
      /Use the exact current native ask/,
      /Do not mechanically redirect to a superior or broadcast to multiple recipients/,
      /Being able to enqueue does not make a session suitable to receive/,
      /not a catch-all\s+Assistant owner/,
    ]) {
      assert.match(front, selection);
    }
    for (const workflow of [
      /stage, completed evidence and remaining dependencies before dispatching/,
      /Message length does not determine recipient or dispatch count/,
      /the current conversation, not unrelated historical matters/,
      /Neither one recipient nor multiple recipients is a default/,
      /Continue an integrated goal with the session responsible for that integration/,
      /Business decomposition, domain\s+dependencies and trade-offs belong there/,
      /do not launch a parallel set of\s+assignments from the entrance/,
      /A partial executor does not gain overall\s+responsibility merely by receiving the first question/,
      /Organize necessary handoffs from that scope, actual responsibilities and known\s+stage dependencies/,
      /do not require the user to issue each internal step as a\s+separate instruction/,
      /Clarify genuinely ambiguous scope or intent, not routine\s+internal decomposition/,
      /Choose the specific recipient needed for each necessary action/,
      /Preserve\s+existing source and rework ownership/,
      /a shared outcome does not transfer every\s+responsibility to one session/,
      /Topic separation does not require new sessions or\s+a message to every owner/,
      /Dispatch only necessary, authorized remaining actions/,
      /development, review\/merge, publication and deployment are distinct\s+stages/,
      /Confirm prerequisites from current native Chat evidence before handing off\s+a dependent stage/,
      /Reuse completed results and existing operation identities/,
      /do not repeat work for organizational symmetry or resend an uncertain operation/,
      /A single executor for a shared operation owns that operation only/,
      /Read the surrounding conversation/,
      /a proposed sequence or hypothetical example is not automatically a new dispatch,\s+retry or reassignment/,
      /If that distinction is unclear, clarify it before taking\s+a new operational action/,
      /Discussion alone neither resumes nor cancels existing work/,
    ]) {
      assert.match(front, workflow);
    }
    for (const continuation of [
      /user's wording and tone where possible, including questions, uncertainty/,
      /Add only context the recipient lacks and needs to understand this turn/,
      /not the full routing rationale, known history or a checklist of standing rules/,
      /Keep added factual context distinguishable from the user's request/,
      /Do not expand an ordinary question into a work order or prescribe analysis\s+directions, conclusions, deliverables or extra requirements the user did not ask\s+for/,
      /Preserve open questions as open questions/,
      /For an authorized execution handoff, include the concrete scope, prerequisites\s+and limits needed for that action without inventing additional obligations/,
      /The recipient should continue answering the user,\s+not be asked to report to the coordinator/,
    ]) {
      assert.match(front, continuation);
    }
    assert.match(front, /Do not expand ordinary questions into work orders or add analysis directions or\s+requirements/);
    assert.match(front, /Clarify only topic, request scope or discussion-versus-execution intent, not business\s+details/);
    assert.doesNotMatch(front, /Only ambiguity about the intended topic is clarified/);
    assert.doesNotMatch(front, /cockpit-task|task_read|parent_assignee|work_mode|orchestrate|Task role/);
    for (const attention of [
      /Watches are independent of topics/,
      /An attention choice is\s+not an assignment, a role change or authorization to start work/,
      /an already enabled watch needs no repeated write/,
      /Do not watch every candidate, helper or historical topic/,
      /organizer role are retired/,
      /Pending pointers, read\s+checkpoints, handling receipts and native history are retained/,
      /Re-enabling does not scan or replay missed history/,
      /without automatic\s+role edits, replacement sessions or background reorganization/,
    ]) assert.match(front, attention);
    assert.doesNotMatch(shared, /Use `assistant_topics` to find|call `assistant_topic`|when it has no suitable match/);
    assert.equal(manifest.instructions, undefined, 'The foreground role must not be injected into all native sessions');
    assert.equal(manifest.frontend, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

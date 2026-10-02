# Native Chat API and setup

Protocol **5** uses native session Chat, not the protocol-4 mirrored transcript.
There is no module frontend. Discover the enabled `assistant` ID/digest in Host
`GET /_modules.active`; its API base is `/_modules/assistant/<digest>/api`.
Native role selection and session IDs come from the ordinary Host APIs.

`GET /state` returns
`{protocolVersion:5,conversation:"native-session-chat",inbox:"evidence-and-disposition",health,schemaVersion:5}`.
`health.current` samples foreground role/resource readiness with `checkedAt`,
`sessionId` and `ready`, `not-ready`, or explicit `unknown`. An unloaded
foreground is unknown, not a failed or completed business task. The check never
loads, sends, resets a failure or replays a notice.
`health.lastWakeAttempt` is null or the historical `{sessionId,state,error,at}`;
states are `loading`, `loaded`, `failed`, or `unknown`. `failed` also includes
resource failure during that actual load attempt. Healthy subsequent checks do
not erase it. `health.pendingUpdates` is the separate number of pending source
locations, not business tasks. `loaded` confirms only
the original handle was observed loaded, not notification delivery or business success.
The old module `/messages`, `/inputs`, `/timeline`, SSE and local-clarification
flows return **410 NATIVE_CHAT_REQUIRED**, not new content with old semantics.
Dashboard and other clients must explicitly move to native `prompt` and
`session/chat`; changing only a URL is not a compatible protocol-4 upgrade.

## Session setup

Create an ordinary native session with the Assistant role (`assistant/coordinator`)
and use the native Chat Composer. The role is exclusive: Host-compatible neutral
connection roles may coexist only when they add no model instructions, Skills
or MCP resources. Other capability roles (including Task Node) and a second
Assistant identity are not compatible. The coordinator and organizer cannot
share one session. Its instructions include the one shared topic Skill; no Skill
reader tool is needed. The Host's public resource-policy and input-origin
capabilities, plus `roleAvailabilityVersion:1`, are required before the service
opens its store. Compatibility is checked through public `roles/availability`,
not connection-role names or a module-owned catalog.

The first receipt-authenticated browser input selects an unconfigured foreground.
Alternatively persist its exact existing ID as `foregroundSessionId`. Other
coordinator-labelled sessions do not take over it. Eligible unread results can
load this original foreground on demand; unrelated activity never creates a new
one. Unloaded is not missing. A role update only
applies to an existing handle after an explicit idle reload.
Cold loading checks the saved selection before requesting the original ID;
loaded use checks exact saved/applied roles, offered tools and actual readiness.
Unknown compatibility, changed selections and incomplete readiness fail closed.
Adding a connection role does not turn a connector's `module`-origin prompt into
a `user`-origin input or grant human business authorization.

Persistent defaults use the Assistant `config` value in Host `modules/config.json`
without changing its `enabled`, version or digest:

```json
{
  "defaultCwd": "/absolute/project",
  "foregroundSessionId": null
}
```

New topics create ordinary native sessions using the Host default model and
resources. Assistant injects no role, private tool scope, Skill or reporting
instructions. These sessions are not an Assistant sandbox. The coordinator and
organizer retain their separate exclusive resource policies.

The existing `worker` configuration key remains compatible; its optional `cwd`,
`roles` and `toolScope` apply only to new sessions. There is no new template API.
Explicit selections retain their native semantics and validation: unsupported
resource/model fields are rejected and custom tool scopes are not widened to
work around native alias or readiness errors.

The removed `assistant/worker` entry is stripped from new-session roles. Only
the exact old built-in preset (that role alone, the seven builtins `view`, `grep`,
`glob`, `bash`, `apply_patch`, `ask_user`, `skill`, and no MCP servers) also drops
its obsolete scope. A scope without that role, with other selected roles, or
with different tools remains explicit and unchanged. This compatibility
interpretation does not write the saved configuration.

Existing topic mappings and saved native roles are never rewritten. Already
loaded legacy sessions may continue, but an unloaded session retaining the
removed role is explicitly rejected before load or send; resolve its saved
role through the Host rather than replacing the topic session. This release
does not migrate production sessions or repair arbitrary custom scopes.

## One MCP endpoint

`POST /mcp` uses the Host role's digest-bound connection and actual
`cockpit/invocation` metadata, not caller-supplied session arguments.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `assistant_topics` | `{after?,limit?}` | Read the register. |
| `assistant_topic` | `{topicId?,title?,content?,archived?,sessionId?}` | Edit the register; omit ID for a new topic. |
| `assistant_dispatch` | `{items:[{topicId,prompt}]}` | Deliver the complete faithful split once for this native human input. |
| `assistant_inbox` | `{ids?,limit?,peek?,decisionsAfter?}` | List locations/read tokens and valid asks with read receipts; no consumption. `peek:true` only counts. |
| `assistant_read` | `{token,offset?,recover?}` | Read bounded native evidence, yielding a service-issued receipt only after the full range or all its fragments. |
| `assistant_resolve` | `{receiptId,disposition:"silent"\|"notify"}` | Resolve only that actual read range; `notify` is intent, not a delivery assertion. |
| `assistant_history` | `{sessionId,cursor?,recent?}` | Read recent dialogue for topic preparation, or an original native page. |
| `assistant_status` | `{topicId}` | Check the native Chat tail, return freshness/read token, runtime facts and independently sampled health. |

The register's `contentUse` and warning identify descriptions as identity,
responsibility and scope only. Legacy text is retained, never promoted to current
progress. Neither registration cardinality nor existing source permissions change.
Only responsibility/scope changes belong in `assistant_topic`; ordinary progress
belongs only in native Chat.

### Evidence and disposition

`assistant_status.freshness` includes `checkedAt`, `headEventId`, `changed`,
`readToken`, and `lastRead` (event ID, receipt ID and read time).
It returns no business evidence. A check reads one persisted tail event; the
current Host has no separate byte-bounded tail-metadata endpoint. Only relevant
registered sources are checked, without loading or scanning all sessions.
No change permits reuse only when actual earlier evidence remains in context.
Otherwise `assistant_read({token,recover:true})` obtains evidence again.

Each read uses one persisted backward page of at most 16 native events. It
returns primary user/assistant content, native errors/aborts and idle markers,
with original event/message identities and timestamps. Tool results, reasoning,
subagent events and ephemeral chunks are not business evidence. `nextToken`
continues a required range; `olderCursor` supports explicitly requested older
history. A first recent window is not all history. Checkpoints advance only
after the new range reaches the prior exact event or the known history end;
partial pagination never skips an unread gap.

Large output uses consecutive JSON text fragments of at most 12,000 UTF-16
characters with `nextOffset`; no receipt is issued until all fragments have
been returned. The service re-reads the same native query and checks its complete
hash, never stores a body cache. The Host RPC itself has an event-count limit,
not a pre-fetch byte limit; upstream failures remain explicit. `cursor-expired`
and `range-changed` do not advance the position. Recovery of a completed token
searches for its exact original IDs using bounded continuation pages. Fresh
recovery after an expired cursor starts at the tail and declares older coverage
unknown rather than inventing an offset. There is no private native-store access.

Inbox listings provide original source locations, not copied result bodies.
Valid native asks include their original question/options and a read receipt;
they are revalidated again before a presentation decision. A `silent` decision
cannot consume a currently valid ask. Legacy unread bodies stay intact in
storage until resolved, but must be recovered from native Chat to count as
current business evidence. Missing evidence is a visible gap, not a fallback to
old descriptions or mailbox text.

A read receipt records exact source IDs, owning foreground, native tool call and
returned range. This proves a tool returned evidence, not model comprehension
or successful receipt of a lost tool response. `assistant_resolve` accepts only
those service-issued receipts. It atomically resolves the included source IDs,
never later arrivals. Silent disposition prevents another wake of those IDs.
`notify` records `awaiting-output`: only an observed primary non-tool assistant
message after the decision's actual native tool-call event in the same interaction
supplies the output event/message ID. Append order, not UUID or timestamp order,
establishes this boundary; earlier commentary cannot count.
This establishes output in native Chat, not delivery to an external connector.
Exact previously handled IDs are returned as such; semantically identical facts
with different IDs are still the Assistant's judgment, not keyword matching.

Unresolved reads and interrupted output intents are returned in
`pendingDecisions.items`, with `nextAfter`/`hasMore` for the next
`assistant_inbox({decisionsAfter})` page. Empty reads cannot displace actionable
decisions. A passive foreground Chat read (at most four 16-event pages) can recover
a missed output observation; `outputRecovery` states its sample time, bounds and
unknown/observed evidence. Absent ordering evidence stays uncertain, never triggers an automatic
resend. Wake `unknown` is separate and is never retried. These receipts do not
claim exactly-once external notification. Recover source evidence and inspect
original foreground Chat before deciding what is still owed to the user.
The foreground may read its own history to restore explicit attention
preferences and prior wording, without exposing unrelated internal sessions.

Native attachments on the genuine source input are forwarded as descriptors.
No preview URL is converted into a path and no second attachment store exists.
Native ask answers require the complete original human words in a single-topic
dispatch; attached or mixed answers are rejected, never silently changed.
Ordinary business dispatch uses native `immediate`: when busy, the target receives
steering in its current run, not a forced restart or independent parallel task.
Ask answers still use `respondAsk`. Neither operation clears existing queues or
replays uncertain deliveries. Foreground result reminders remain `enqueue`.

Ordinary reminders wait for source idle (or a settled native error), then for an
idle foreground. When eligible pending entries exist and the original foreground
is unloaded, the service requests `session/load` once, checks its identity and
actual role resources, and revalidates eligibility before `enqueue`. It never
reloads an already-loaded foreground or interrupts its work/ask/queue.
A valid native question bypasses the source-idle wait. Inbox
reads revalidate questions: stale ones are no longer offered; unavailable
unloaded questions stay unread without being presented as live. `peek` and
`hasMore` count currently readable entries, excluding unavailable questions.
Explicit reads may include accumulated partial replies before idle; do not infer
business completion from a read or reminder. See [notification semantics](architecture.md#inbox-and-notices).

Load failures retain unread entries and report a service error. `health`
is also included in `assistant_status`; an interrupted or unconfirmed load is
`unknown`, not permission to retry. After inspecting the failure, use the normal
Host API to load the **same original ID** and repair its role resources if needed.
A subsequent native change can resume notification after readback; there is no
retry timer, replacement session or wake-reset endpoint. A deleted selected ID
returns `FOREGROUND_MISSING`; a failed native read retains its original error
instead of being called deletion. Uncertain prompt receipts remain unknown even
after foreground recovery and are never replayed.

MCP success means the stated local operation or native acceptance, not successful
business completion. Transport uncertainty is not permission to repeat a send.
An accepted reminder, read receipt and output receipt are different facts.
Progress queries and reminders never authorize business dispatch. The
receipt-authenticated browser input requirement (`HUMAN_REQUIRED`) remains:
generic API/module input, including unproven connector ingress, cannot dispatch
or answer for the human merely because it can read evidence.

### Partial creation

Topic responses include `creationReceipt` alongside the bound `sessionId`.
A creation failure retains its actual `sessionId`/`createdId` when supplied,
error code and stage (`creation`, `readiness`, or `binding`), with
`promptAttempted:false`. The stage describes the operation that failed, not
an inferred rollback; an unconfirmed native creation stays unknown. Existing
receipts are returned unchanged, including older receipts without stage fields.

`assistant_status` exposes this receipt even when no session could be bound.
It does not load that identity or claim the closed empty session is recoverable.
History authorization is unchanged: a failed creation receipt is not a new
general-purpose history capability. Unknown creation/delivery is never
automatically retried, reset or replaced.

### Recent dialogue

`assistant_history({sessionId,recent:true})` returns at most the latest **three**
nonempty primary `user.message` / `assistant.message` bodies in append order,
oldest first. The organizer defaults to this view. Tool events, subagent events,
ephemeral chunks, empty tool-call messages, attachments and opaque model metadata
are not included. Bodies accompanying a main-agent tool call remain dialogue.
Native event IDs and message IDs (when present) identify each excerpt.

The service reads persisted history without loading the source or saving a
transcript. It searches at most 16 native pages of 32 events to find the sample.
Each body's JSON-encoded UTF-8 text is limited to 3,000 bytes, without splitting
a surrogate pair; `truncated` and `originalLength` (UTF-16 units) identify
shortened bodies. The response is capped at 12,000 JSON-encoded UTF-8 bytes.
An oversized native identity fails explicitly rather than overflowing the tool.

The response has `view:"recent"`, `limit:3`, `order:"oldest-first"`, `messages`,
`complete`, `scanLimited` and `read:{pages,events}`. `complete` means the latest
three messages were found or native history ended with fewer messages; it never
means all historical topics or a business task are complete. `scanLimited:true`
means the search budget ended first, not that the conversation is empty.
Native failures, expired cursors and nonadvancing pages fail explicitly without
claiming a complete sample.

Recent sampling always starts at the latest event and rejects `cursor`.
`recent:false` preserves the original 16-event native page and its opaque cursor
for explicitly requested history checks. This remains the foreground default,
including after disposition; original Chat history is never shortened.

## Organizer

The separate organizer role has only topics/topic/history tools, not delivery or
inbox. Select sources in the current native user input using an explicit line:

```text
historySessionIds: ["actual-native-session-id"]
```

Only those sources may be read or registered in that interaction. This is not a
permission to scan all histories, dispatch business or become the foreground.
Sharing the topic Skill does not confer another session's identity.

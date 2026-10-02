# Native Chat API and setup

Protocol **5** uses native session Chat, not the protocol-4 mirrored transcript.
There is no module frontend. Discover the enabled `assistant` ID/digest in Host
`GET /_modules.active`; its API base is `/_modules/assistant/<digest>/api`.
Native role selection and session IDs come from the ordinary Host APIs.

`GET /state` returns
`{protocolVersion:5,conversation:"native-session-chat",inbox:"consume-on-read",foregroundSessionId,foregroundWake,schemaVersion:5}`.
`foregroundWake` is null or the last load attempt's `{sessionId,state,error}`;
states are `loading`, `loaded`, `failed`, or `unknown`. `failed` also includes
post-load role/resource failures. `loaded` confirms only
the original handle was observed loaded, not notification delivery or business success.
The old module `/messages`, `/inputs`, `/timeline`, SSE and local-clarification
flows return **410 NATIVE_CHAT_REQUIRED**, not new content with old semantics.
Dashboard and other clients must explicitly move to native `prompt` and
`session/chat`; changing only a URL is not a compatible protocol-4 upgrade.

## Session setup

Create an ordinary native session with the Assistant role (`assistant/coordinator`)
and use the native Chat Composer. The role is exclusive: do not combine it with
unrelated roles. Its instructions include the one shared topic Skill; no Skill
reader tool is needed. The Host's public resource-policy and input-origin
capabilities are required before the service opens its store.

The first receipt-authenticated browser input selects an unconfigured foreground.
Alternatively persist its exact existing ID as `foregroundSessionId`. Other
coordinator-labelled sessions do not take over it. Eligible unread results can
load this original foreground on demand; unrelated activity never creates a new
one. Unloaded is not missing. A role update only
applies to an existing handle after an explicit idle reload.

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
| `assistant_inbox` | `{ids?,limit?,peek?}` | Read and consume returned entries; `peek:true` only counts. |
| `assistant_history` | `{sessionId,cursor?,recent?}` | Read recent dialogue for topic preparation, or an original native page. |
| `assistant_status` | `{topicId}` | Inspect mapping and native activity/question facts. |

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

Load failures retain unread entries and report a service error. `foregroundWake`
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
Reading a consumed inbox response again uses `assistant_history`, not replay.

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
including after inbox consumption; original Chat history is never shortened.

## Organizer

The separate organizer role has only topics/topic/history tools, not delivery or
inbox. Select sources in the current native user input using an explicit line:

```text
historySessionIds: ["actual-native-session-id"]
```

Only those sources may be read or registered in that interaction. This is not a
permission to scan all histories, dispatch business or become the foreground.
Sharing the topic Skill does not confer another session's identity.

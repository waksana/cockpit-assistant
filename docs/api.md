# API and setup

Assistant routes are relative to the authenticated, digest-bound module API
base discovered from the Host's module listing. Never hardcode an installation
digest, reach into SQLite or use a private native handle. Module HTTP and native
MCP caller identity are different boundaries.

## Discover the foreground protocol

The module's public configuration advertises `protocolVersion: 4`. Before
reading the main transcript or sending an input, clients read `GET /state` and
require:

```json
{
  "protocolVersion": 4,
  "timelineProtocol": "foreground-message-snapshots-v1",
  "legacyTimelinePath": "/legacy/timeline"
}
```

Other state fields include host-supplied configuration, observed role/readiness
facts, the message revision watermark and database schema version. The protocol
version is not the module SDK version or a proof that a particular native
session has applied its role and tool scope.

Protocol 4 changes conversation ownership: the default transcript is the real
user and foreground Assistant, not a stream of all background replies.
Protocol 3 history remains an explicit read-only archive. A client must not
silently interpret that old aggregation feed as the new foreground conversation.
This includes non-Web clients such as Dashboard.

## Client conversation

| Method and path | Body or query | Meaning |
| --- | --- | --- |
| `POST /messages` | `{requestId,text,attachments?}` | Save one genuine client input and send it to the continuous foreground session. |
| `GET /inputs/:requestId` | None | Inspect the original saved input and any derived topic-message delivery facts. |
| `GET /timeline?limit=50` | Bounded tail | Current user/foreground message snapshots in stable display order. |
| `GET /timeline?before=N&limit=50` | Display sequence | Earlier main-conversation rows, exclusive. |
| `GET /timeline?after=N&limit=100` | Snapshot revision | Newer current snapshots, exclusive and revision ordered. |
| `GET /timeline/items/:sequence` | None | Current projection at one stable display position. |
| `GET /timeline/stream?after=N` | SSE | Main-conversation snapshots; `Last-Event-ID` takes precedence. |
| `GET /legacy/timeline` | Same bounded history parameters | Retained old conversation, never reclassified or dispatched. |

Bodies are strict JSON. Known errors have `{error:{code,message,status,...}}`
and the corresponding HTTP status. Request IDs refer to immutable content;
changed content under the same ID conflicts. Acceptance means saved/native
acceptance as stated by the receipt, not recipient completion.

The input body remains `{requestId,text,attachments}`. Native file, directory,
selection and blob descriptors are preserved and bounded. Empty text requires
an attachment; a preview URL is not a native file path. The service supplies
the original attachments to each relevant split prompt, not another copied
user bubble.

`InputReceipt` retains `requestId`, `input`, `message`, `topicMessages` and
`hasMore.topicMessages`. Original protocol-3 receipts can still be inspected
without restarting the old classifier. On timeout, inspect the exact original
request; do not resubmit merely because a response was lost.

### Snapshot identity and display

Each timeline item retains `id === messageId`, stable `sequence` and changing
`snapshotRevision`, plus `text`, `attachments`, `speaker`, `createdAt`,
`sessionId`, nullable question/diagnostic fields and delivery diagnostics.
Only actual foreground responses and genuine client originals enter the main
feed. Worker originals and service notifications do not become extra bubbles.

The SSE event name remains `publication` for transport compatibility. Its ID
is `snapshotRevision`, not the display sequence. Revisions may skip; there is
no gap-free publication log. Merge a newer snapshot by message identity,
preserving display order, DOM identity and reading position. Start with the
tail page's watermark and use separate revision and history cursors.

Legacy rows can retain `topicTitle` and `clarifications`. Those are historical
display facts, not new classification instructions. The Web archive has no
working clarification buttons. The old clarification GET can inspect retained
answers; its retired POST flow is not used for foreground input.

### Human answers

Business worker questions are read with their real native session/request
identity and presented by the foreground. The next relevant genuine user input
may be faithfully routed as the answer. The service, not the model or another
worker, calls the exact native response API and validates literal choices,
freeform permission and attachment restrictions.

Native answers use a single-topic dispatch whose prompt matches the complete
genuine user message. The service reads the actual answer from that immutable
original and binds it to the exact native question; model-generated split text
cannot replace it. A constrained choice must match the whole answer, not a
substring found in a negation, quotation or request to explain the options.
Freeform answers also preserve the user's words. A mixed or ambiguous input
must be answered separately; rejection leaves the question pending.

There is no unrestricted model-facing answer tool. A result notification,
worker statement or peer input cannot supply a human answer. Normal prompt
delivery is not evidence that an outstanding native ask was answered.

## Foreground and worker setup

| Method and path | Body | Meaning |
| --- | --- | --- |
| `GET /readiness` | None | Current foreground role and actual tool-scope observations. |
| `POST /roles/activate` | `{requestId,bindings:[{role:"coordinator",sessionId}]}` | Load the exact saved foreground carrier if appropriate; no replacement creation. |
| `POST /roles/bind` | `{requestId,role,sessionId}` | Explicitly select/prepare `coordinator` or prepare a separate `organizer` carrier. |
| `POST /sessions` | `{requestId,cwd,role}` | Explicit operator setup; `role` is `coordinator`, `organizer` or `worker`. |
| `GET /sessions/:id/inspect` | None | Actual metadata for that exact session. |
| `GET /operations/:id` | None | Current-process setup receipt, or an explicit unavailable result. |

Role selection is not proof of application or readiness. Unloaded is different
from missing; a busy carrier is not replaced. Setup receipts are not a generic
durable effects system and may be unavailable after restart. Read actual Host
state before any explicit recovery.

The foreground uses an actual persisted native tool scope: no built-in tools
and only the Assistant service MCP subset. The required shared topic guidance
is embedded into its role instructions at build time, not loaded by a forbidden
shell, filesystem or Skill tool. Configuration and actual offered tools must
agree; a role label or a successful resource enable operation is not evidence
of tool restriction.

## Foreground MCP toolkit

The HTTP MCP endpoint supports initialize, ping, tool listing and tool calls.
The Host supplies the trusted primary-session and tool-call identity. Caller
arguments cannot substitute for that identity. A manually selected organizer
has a smaller tool set and does not acquire foreground dispatch authority.

| Tool | Main arguments | Boundary |
| --- | --- | --- |
| `assistant_topics` | `{after?,limit?}` | Bounded current topic register. |
| `assistant_topic` | `{topicId?,title?,content?,archived?,sessionId?}` | Necessary register edits under a genuine human or explicitly scoped organizer request. |
| `assistant_dispatch` | `{items:[{topicId,prompt}]}` | One saved, faithful split from a genuine foreground user input; service sends it. |
| `assistant_status` | `{topicId?}` | Actual state of registered workers, not inferred business completion. |
| `assistant_inbox` | `{ids?,after?,limit?}` or `{presentation:{ids,text}}` | Read pending results or associate selected IDs with the complete planned natural reply. Neither operation alone consumes a body. |
| `assistant_history` | `{sessionId,cursor?}` | Bounded related native history within the permitted session scope. |
| `assistant_source` | `{messageId}` | A relevant saved genuine user original, not an additional authority grant. |
| `assistant_sessions` | `{after?,limit?}` | Manual organizer candidate metadata, not automatic enrollment. |

There is no per-message `assistant_complete`, lease, token, epoch or
classification ACK protocol. Result notifications permit reads and presentation,
not new business dispatch. Differing or incomplete worker results do not grant
permission to send another business prompt.

For presentation, the foreground identifies only the inbox IDs it read in this
interaction and actually represents in its planned reply. The service records
their expected full-text hash and the declaration boundary, not another body
copy. Only a later matching persistent natural reply in that interaction
consumes those IDs. An unrelated ledger answer, a partial presentation, a tool
prelude or an old/duplicate reply does not clear the other read results.

The declaration result is
`{declared,ids,sessionId,interactionId,textHash,afterSequence,normalization}`.
`normalization: "crlf-to-lf-outer-trim-v1"` changes CRLF or lone CR to LF and trims only
outer whitespace before hashing. It does not paraphrase, extract sentences or
normalize away omitted content. Native answers likewise allow only outer
whitespace normalization when comparing the full human original.

Reads and declarations survive cancellation or interruption without deleting
unpresented bodies. This is internal consumption bookkeeping, not a user ACK or
a per-input classification step. Consumed native identities remain so duplicate
observation cannot restore an already-cleared body. Source histories and shared
files are never deleted by this process.

## Persistent defaults and manual organization

Persistent module defaults belong to the Assistant entry in the Host's
`modules/config.json`; preserve its selected version, digest and enabled fields.
The Host supplies these values on cold start. `PATCH /config` does not claim a
persistent configuration write when the public Host API provides none.
See the [Host configuration contract](https://github.com/waksana/cockpit/blob/main/docs/module-contract.md#storage-config).

For example, the module's **config value**, not the entire Host configuration
file, can select a discussion-only worker template:

```json
{
  "defaultCwd": "/absolute/project",
  "foregroundSessionId": null,
  "worker": {
    "cwd": "/absolute/project",
    "roles": [{ "moduleId": "assistant", "roleId": "worker" }],
    "toolScope": { "builtins": ["ask_user"], "mcpServers": [] }
  }
}
```

Use a real existing absolute directory. This explicit example permits native
questions but no worker shell or MCP tools; choose the actual tools needed for
an execution template instead. A new worker always receives the `worker` role;
it must not carry Assistant foreground or organizer roles. Additional persistent
Skill/MCP contributions come from the selected roles and remain intersected
with the explicit tool scope. Nonempty top-level `worker.skills` and
`worker.mcpServers` reject: one-time resource preparation is not a persistent
template. There is no per-template model override in this API; new sessions
inherit the Host's persistent default model.

`foregroundSessionId: null` starts unbound; role labels do not select a
foreground. An explicit bind/activate selects an ID for the current service
instance only. Persist that exact native ID in `foregroundSessionId` to retain
the selection across restarts; a setup receipt is not a saved config write.
Creating or selecting a role does not retrofit a tool scope
onto an old unscoped session: the current Host scope is immutable after creation.
Use explicit setup to create an appropriately scoped foreground, retain any
old session/history, and select the new ID rather than relabelling an unsafe
carrier as ready.

New-worker defaults and foreground selection are separate. A template is not
retroactively applied to existing workers. Cwd and selected roles must actually
take effect; resource and model settings must follow the exact supported
creation/cold-load behavior, with unsupported fields rejected rather than
ignored. A selected Skill is not itself an OS sandbox or proof its body was read.

A manual organizer is a separate native session using the `organizer` role and
shared `assistant-topics` Skill. It does not receive foreground conversation or
automatic result notifications. Create it with `POST /sessions` using
`role:"organizer"`, then explicitly prepare that exact ID with `POST /roles/bind`
and `role:"organizer"`. Its source scope is explicit:

```text
POST /organizers/:id/messages
{ requestId, text, historySessionIds: [selected native session IDs] }
```

This service-recorded request authorizes the bounded selected-history workflow;
the native channel name `user.message` alone does not establish who sent it.
An organizer can propose topics and, when explicitly requested, register/link
existing sessions. It cannot dispatch business or answer another session's ask.
No production-wide history scan is started by selecting the role or Skill.

## Compatibility and operational limits

The forward schema transition preserves existing topics, mappings, original
messages and delivery evidence. It does not restart old unprocessed classifier
work or clear the current database. Package publication and deployment are
separate; see [releases](releases.md).

Unknown native outcomes require inspection. No API promises global exactly-once
delivery, permanent opaque history cursors, restoration of deleted native
history, or complete observation while the service is stopped.

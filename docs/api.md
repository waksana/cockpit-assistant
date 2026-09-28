# API and role setup

Assistant is a trusted same-process Cockpit module with a global conversation UI:
no standalone server, Task dependency, or OS sandbox. One activation owns one private
Assistant space and its `dataRoot/assistant.sqlite`. Use Linux and Node.js 24
with built-in `node:sqlite`.

The installed public SDK dependency is pinned to
`@waksana/cockpit-module-sdk@0.6.0`, including the native methods used here.
The host compatibility reference is commit
[`af4c8a227053640ae7c113c8849543a6731a5e19`](https://github.com/waksana/cockpit/commit/af4c8a227053640ae7c113c8849543a6731a5e19),
release `v0.0.0-rolling.20`; see its fixed
[role lifecycle contract](https://github.com/waksana/cockpit/blob/af4c8a227053640ae7c113c8849543a6731a5e19/docs/module-contract.md#role-assignment-lifecycle).
Activation requires `serviceReadyVersion`, `chatReadVersion`,
`askResponseVersion`, `resourcePreparationVersion`, `roleAssignmentVersion`,
`sessionDirectoryVersion`, and `sessionLoadVersion` all equal to `1`.
Frontend activation separately requires Web API `2`, `globalComponentVersion`,
`menuVersion`, `uiVersion`, and `uiSurfaceVersion` all `1`, and host `createPortal`.
Rolling publication is described in [releases](releases.md). Source merge and
publication do not install/deploy or establish production/native-model
end-to-end verification.

## Transport and scope

All paths below are relative to the active host module API base:

```text
<host-origin>/_modules/assistant/<active-package-digest>/api
```

Discover the active digest through the host's `GET /_modules`. Use the host's
trusted authentication/origin policy; Assistant has no separate login or token.
Send `Content-Type: application/json` for writes and
`X-Cockpit-Module-Digest: <active-package-digest>` for mutating requests.
The digest header is optional for GET, but, if present, must match. Digest binding
is not authentication; stale digest URLs do not select newer packages.
Do not expose this management API as an untrusted multi-user boundary.

Management HTTP reads cover this Assistant space, not arbitrary native history.
Ordinary sessions are automatically discovered through the public metadata
directory and maintained through session events. Their durable reception records
are delivery targets, not a separately configured role. Saved/applied internal
role identities and registered coordinator/memory carriers are excluded, cannot
share a carrier, and never receive ordinary user conversation.

Management bodies and MCP tool arguments are strict objects: unknown fields,
incorrect types, and malformed versions are rejected. Management writes accept
no query parameters. JSON bodies
are limited to 2,000,000 bytes. Successful management responses are JSON values,
not a universal `{ok: true}` envelope. Known failures return
`{"error":{"code":"…","message":"…","status":409}}`; validation failures use
`INVALID_INPUT`, HTTP 400, and include `issues`. Host failures may differ.
Before service readiness or after shutdown, routes reject with `NOT_READY`/503.

### IDs, idempotence, and versions

- `requestId` is a caller-chosen stable string of 1–200 characters. Reuse it only
  for the identical logical request; a changed parsed payload produces
  `IDEMPOTENCY_CONFLICT`. IDs are scoped by operation family, not globally.
- Ordinary IDs and lease tokens are 1–200 characters; operation IDs in resolve
  paths may be up to 512. URL-encode path IDs.
- Versions/epochs are integers. Content/topic/reception versions and active role
  epochs are positive; assignment/state/route versions and `expectedEpoch`
  permit zero.
- `text` is 1–100,000 characters unless specified otherwise. `evidence` and
  correction/reclassification reasons are trimmed, nonempty, at most 4,000.
  Decision reasons are nonempty, at most 4,000.
- Idempotence records durable outcomes, not exactly-once native execution.
  Inspect receipts after uncertainty; do not invent a new request ID to repeat a
  business send. Some operations return a direct result initially and an
  operation record on replay. Inspect `state` and `result`, not HTTP success alone.

An operation has `{id, fingerprint, state, result}`. A delivery additionally
records its fixed `sessionId`, `kind` (`prompt`, `ask`, or internal `wake`),
message/request IDs, literal `text`, optional `supplement`, `answerFreeform`,
`error`, and role epoch. States are `pending`, `calling`, `accepted`, `rejected`,
`unknown`, or `cancelled`. `accepted` means observed acceptance, not model reading,
completion, or successful work.

## Minimal initialization

Use an already authorized, active module installation. Build/dependency commands
are in the [README](../README.md#development); installation and restart are
separate operator actions, not initialization side effects.

Select `coordinator` and `memory` on **two separate sessions** in Cockpit's normal
session creation or add-role controls. The host asks Assistant whether each role
can be assigned, then notifies it after the native role save. Assistant registers
that session without claiming readiness. A still-existing carrier retains its
role even when unloaded or unavailable; a second session cannot replace it.
Ordinary sessions require no manual registration.

Opening Assistant checks the saved carriers and may load an unloaded carrier.
The UI retains a durable activation receipt if loading is uncertain and never
creates a replacement internal session. Missing carriers, unapplied roles and
resource-readiness failures remain explicit. New business input still requires
both roles to pass fresh verification at the send boundary.

Creating or cold-loading a role session includes the host's normal native tool
initialization. Loading never reapplies roles to an already-loaded handle or
repairs intentionally disabled resources. Refresh is passive. Use Cockpit's
explicit controls to apply pending roles or change resource settings.

Directory discovery does not retroactively register old role selections.
Explicit host `roles/add` with the same saved selections can deliver a missing
notification without saving again. For a known failed notification, use the
host's `roles/notify` with its original `notificationId`; no automatic retry or
replacement is performed. A partial creation receipt preserves `sessionId`,
the native error `code`, and the full `roleAssignment` recovery object.
An ID or `saved:true` alone is not proof of native creation or readiness.

### Explicit management and recovery

The existing management APIs remain available for deliberate operations, not as
the normal role setup flow:

1. `POST /sessions` explicitly creates a native session:

   ```json
   {"requestId":"create-coordinator-1","cwd":"/absolute/project","role":"coordinator"}
   ```

   ```json
   {"requestId":"create-memory-1","cwd":"/absolute/project","role":"memory"}
   ```

   The optional `role` adds `{moduleId:"assistant",roleId:<role>}` at creation.
   Omit it only for an explicitly requested ordinary session. Role creation
   uses the same host role-save callbacks and sends no prompt. Save the native result and
   `create:<requestId>` receipt. Never repeat uncertain creation with a new ID.

2. Inspect each original session through Cockpit's native controls for its
   actual model, working directory, loaded state, and applied role/resources.
   Creation uses the host default model; `/sessions` has no model parameter.
   Arrange any intended native model change explicitly. For an explicit recovery
   binding, use its **actual expected model ID** and current binding epoch:

   ```json
   {"requestId":"bind-coordinator-1","role":"coordinator","sessionId":"COORDINATOR_SESSION","expectedEpoch":0,"definitionVersion":"1","expectedModelId":"ACTUAL_MODEL_ID"}
   ```

   ```json
   {"requestId":"bind-memory-1","role":"memory","sessionId":"MEMORY_SESSION","expectedEpoch":0,"definitionVersion":"1","expectedModelId":"ACTUAL_MODEL_ID"}
   ```

   Send these to `POST /roles/bind`. Binding prepares the existing `assistant`
   MCP server with the exact role tools, checks actual role readiness, records
   the native working directory/model, and advances the binding epoch. Saved role labels
   or an enabled MCP switch alone are not readiness. Binding does not install
   resources or authenticate servers. Preparation can have effects even if
   binding fails: inspect the `bind:<requestId>` receipt and native state.

3. `/enrollment` is a legacy management endpoint, not a setup prerequisite:

   ```json
   {"requestId":"enroll-reception-1","sessionId":"RECEPTION_SESSION","label":"Project reception","kind":"reception","evidence":"User selected this existing session for this conversation."}
   ```

   Automatically observed sessions already have reception records and reject a
   second enrollment. All ordinary sessions are direct reception targets under
   the current policy; legacy disabled/collaborator state is normalized when
   that session is observed again. No ordinary session is loaded just to observe
   it. A coordinator can request an ordinary session for a current unanchored
   input using the dedicated creation tool; it cannot create internal carriers.

4. With both bound roles freshly ready, submit user input through `POST /messages`:

   ```json
   {"requestId":"input-1","text":"Review the project plan."}
   ```

   The response is `{message, work}`. This persists source input and pending
   coordinator work; it does **not** yet publish the input or send it to a
   reception. The runtime queues an internal role wake. Only a committed
   coordinator decision publishes classified input and queues a delivery or
   clarification. Read `/deliveries` and the publication log for later outcomes.
   New input now passively verifies both current roles at this boundary; an
   unavailable role rejects with `ROLES_NOT_READY` before acceptance. An identical
   already-durable request still returns its original result if readiness later
   changes. Direct internal `service.accept` remains synchronous.

`GET /status` exposes config, `stateVersion`, `foregroundTopic`, role bindings,
and `publicationCursor`. `POST /roles/verify` (or role `/refresh`) rechecks an
existing epoch against native loaded/model/directory/applied-role readiness.
Neither route reloads or repairs a session. An intentional role replacement uses
`/roles/bind` with the **current** `expectedEpoch`; the new epoch retires old
leases and cancels still-pending old wakes, not already sent business effects.

## HTTP route reference

Every write below requires `requestId`. Bracketed fields are optional; notation
is descriptive, not literal JSON. `role` is `coordinator | memory`.

### Reads and pagination

The UI's bounded recent/upward timeline, enriched stream, fresh readiness and
exact receipts are documented in [interface API additions](interface.md#backend-additions).
The table routes below retain their original forward-pagination semantics.

| Method/path | Query and result |
| --- | --- |
| `GET /state`, `GET /status` | No query; same state summary described above. |
| `GET /topics`, `/receptions`, `/questions`, `/messages`, `/deliveries`, `/operations`, `/memories`, `/roles`, `/risks`, `/routes` | `after=0&limit=50`; `{items,cursor,hasMore}`. |
| `GET /publications`, `/history`, `/events` | Aliases for the publication log; same pagination. `/history` is not raw native history. |
| `GET /events/stream` | Optional `after`; SSE, described below. |
| `GET /roles/:role` | No query; current binding. |
| `GET /messages/:id/versions/:version` | No query; positive content version; `{message,correction}` (correction metadata may be null). |
| `GET /messages/:id/assignments/:version` | No query; nonnegative assignment version; `{messageId,assignmentVersion,topicId,reason}`. |

`after` is a nonnegative integer cursor; `limit` is 1–100, default 50. Pass
returned `cursor` unchanged as the next `after`, and continue while `hasMore`.
No topic/session filters or arbitrary single-record GET endpoints are provided.
Cursors follow table insertion order, not UUID ordering or update time; mutable
tables are not change feeds. Restart their pagination at zero to inspect updates.

Publication records carry `{id,sequence,type,messageId,topicId,text,anchorId,
sources,createdAt}`. Types are `message`, `question`, `status`, `correction`,
`risk`, and `clarification`. `text` is the complete display value; the original
`Message.raw` and native provenance remain separate. A message also records
content/assignment versions, `historical`, and `correlation:"unknown"`.

SSE emits whole records, never model tokens:

```text
id: 12
event: publication
data: {"id":"…","sequence":12,"type":"message","messageId":"…","topicId":"…","text":"Complete display text","anchorId":"…","sources":[],"createdAt":0}

```

Reconnect with `Last-Event-ID: 12` after fully consuming that record. The header
takes precedence over URL `after`, including an EventSource URL's old cursor.
Deduplicate by sequence. Keepalive comments are sent about every 15 seconds
while idle; abort closes the stream. Host `publications-available` module events
are only hints to reread this durable log, not publications or read receipts.

### Setup and management writes

| Method/path | Body besides `requestId` |
| --- | --- |
| `POST /sessions` | `cwd` (1–4,000 characters), `[role]`; explicit native creation. |
| `POST /enrollment` | `sessionId`, `label` (1–240), `kind:"reception"|"collaborator"`, `evidence` (1–4,000). |
| `POST /roles/bind` | `role`, `sessionId`, `expectedEpoch`, `definitionVersion:"1"`, `expectedModelId`. |
| `POST /roles/activate` | `bindings:[{role,sessionId,epoch}]`; exact current registered carriers, loads only those that are unloaded. Returns a durable `activate:<requestId>` operation. |
| `POST /roles/verify` | `role`, positive `expectedEpoch`. |
| `POST /roles/:role/refresh` | Positive `expectedEpoch`; role comes from path. |
| `PATCH /config` | `config:{[riskEnabled],[riskCooldownMs],[maxReceptions]}`. |
| `PATCH /topics/:id` | `expectedVersion`, at least one of `[title]`, `[domain]`, `[pinned]`, `[archived]`, `[independent]`. |
| `PATCH /receptions/:id` | `expectedVersion`, `evidence`, at least one of `[enabled]`, `[kind]`, `[label]`. |
| `POST /focus` | `topicId`; changes foreground and schedules departed-topic memory. |
| `POST /handoff` | `topicId`, `evidence`; schedules memory-role handoff work, not a native transfer; returns `{work,evidence}` (work may be null). |
| `POST /risk/suppress` | `sessionId`, current risk `signature`, `confirmed:true`, `evidence`; explicit continue-sharing acknowledgment. |
| `POST /wake` | No additional fields; runs a work pump, returning an operation receipt. Not an effect retry or a session creation. |

`title`/`label` patches are trimmed nonempty strings of at most 240 characters;
`domain` is a string of at most 240 or null. Flags are booleans. Re-enrollment is
rejected: patch the existing record, using its current version. Changing enabled
state or kind invalidates in-flight reception readers through its generation.

Config defaults are `riskEnabled:true`, `riskCooldownMs:600000`,
`maxReceptions:32`. Allowed cooldown is 0–86,400,000 milliseconds; reception
limit is 1–100 and only limits legacy explicit enrollment, not automatic ordinary
session observation. Installed module config is validated at activation but seeds the
database **only once**. Thereafter `PATCH /config` merges live, persisted values;
editing installed config does not overwrite the initialized store on restart.

### Conversation and recovery writes

| Method/path | Body besides `requestId` |
| --- | --- |
| `POST /messages` | `text`, `[replyTo]` (publication anchor ID), `[topicId]` (existing topic). |
| `POST /messages/:id/correct` | `expectedVersion`, `text`, `reason`; returns an operation receipt. |
| `POST /messages/:id/reclassify` | `expectedVersion`, `expectedAssignmentVersion`, `topic` (schema below), `reason`. |
| `POST /receptions/:id/recover` | `maxPages` (1–10), `acknowledgeGap:true`, `evidence`. |
| `POST /effects/:id/resolve` | `target:"delivery"|"operation"`, `state:"accepted"|"rejected"|"cancelled"`, `evidence`. |
| `POST /operations/:id/resolve` | `state:"accepted"|"rejected"|"cancelled"`, `evidence`; operation-only alias. |
| `POST /effects/:id/retry` | `evidence`; only a rejected internal wake can acquire a successor. |
| `POST /mcp` | JSON-RPC envelope, not the management `requestId` convention; see below. |

Correction retains prior bodies, invalidates dependent memory/leases, and
publishes a correction notice. Reclassification preserves provenance/anchors and
prior publications. Neither resends an already decided instruction. Pending,
undecided input gets fresh work. Native ask source text is immutable through
`/correct`. Read the current source and version/assignment endpoints to render
corrections without rewriting the original publication.

Recovery reads the **loaded original** observed session, at most `maxPages`
native pages of 64 events each. Initial observation already bootstraps the recent
tail as historical, then reads forward; it is not a full archive import. Cursor
expiry records a gap and stops forward consumption until explicit recovery.
Successful recovery returns `sessionId`, `pages`, `historical:true`,
`olderHistoryRemaining`, `backwardCursor`, `liveCursor`, `evidence`, and a warning;
the receipt is `history-recovery:<requestId>` in `/operations`. A stable replay
returns that receipt. Imported pages may survive failure: inspect an `unknown`
receipt's progress before a separately authorized new recovery operation.
Recovery resets the live continuation; it does not prove gap-free coverage.
There is no API to continue its saved backward cursor. Historical outputs may
be classified/suppressed, never published as newly received replies.

On restart, `calling` effects become `unknown`, not retryable pending effects.
Only `unknown` effects can be resolved. Disposition records evidence and the
previous result; it does not call native APIs, roll back, or independently prove
what happened. An unresolved creation blocks further creation. No automatic or
API retry exists for business prompts/answers, including rejected ones.
`/effects/:id/retry` accepts only a `wake` in `rejected` state for the same ready
current role/epoch; each original gets at most one successor. It cannot retry
accepted/unknown wakes or revive retired carriers.

## MCP role workflow

The manifest exposes `/mcp` through the role's host-managed HTTP server:

| Role | Allowed tools |
| --- | --- |
| `coordinator` | `assistant_read`, `assistant_claim`, `assistant_decide`, `assistant_create_session` |
| `memory` | `assistant_read`, `assistant_claim`, `assistant_remember` |

POST JSON-RPC 2.0 supports `initialize`, `ping`, `tools/list`, and `tools/call`;
notifications return HTTP 202. Supported MCP protocols are `2025-11-25`,
`2025-06-18`, `2025-03-26`. An unsupported `MCP-Protocol-Version` header is
rejected; initialize negotiates a supported version. `tools/list` supplies the
full strict JSON schemas. Tool results contain JSON-encoded text in `content`
with `isError`; JSON-RPC success alone is not tool success.

The host attaches `params._meta["cockpit/invocation"]` with observed `sessionId`,
`runtimeSessionId`, `subagent`, and optional `agentName`. Do not supply identity
in tool arguments or manufacture it in an HTTP client. Calls require the bound
main session (`subagent:false`, equal session/runtime IDs), current ready epoch,
and rechecked native model/directory/role readiness.

### Creating an ordinary topic carrier

`assistant_create_session` accepts the same current coordinator work proof as a
decision, plus an explicit absolute `cwd` and nonempty `reason`. It is limited
to a claimed ordinary user input: no historical/native output, anchored reply,
or possible literal answer to a pending native question. If the required
directory is unknown, the coordinator asks a clarification rather than inventing
one. Native creation uses the host default model and no internal roles.

The `topic-create:<workId>` operation reserves one creation for that input;
`topic-create-request:<requestId>` preserves the original request receipt.
The result includes `createdId`, `nativeOperationId`, original native result,
`observation`, and `retryAllowed`. Native creation and automatic observation
are separate facts: observation failure never erases a created session or permits
recreation. Unknown and in-flight creations cannot be retried under a new ID.
Only an explicit known rejection before native intent was reserved can permit
a corrected request. Stable replay preserves the original receipt.

Creation does not route input or complete work. Read the receipt through
`assistant_read {resource:"receipts",workId,...}` (`sessionCreation`), then
claim/read fresh state and use `assistant_decide` to select the created target.
The original work/epoch and native receipt remain auditable.

### Claim, read, and proof

`assistant_claim` accepts `{role,epoch,[workId]}` and returns a work item or
null. A claim lasts five minutes and includes `id`, `token`, `inputVersion`,
`stateVersion`, `epoch`, `messageId`/`topicId`, frozen `sources`, and `through`.
Reclaiming refreshes the token/snapshot; never reuse old proof afterward.
Null means no claimable work, not delivery completion.

`assistant_read` accepts:

```json
{"role":"coordinator","epoch":1,"resource":"messages","after":0,"limit":50}
```

Resources are `work`, `receipts`, `topics`, `routes`, `receptions`, `messages`,
`questions`, `memories`, and `deliveries`; optional `workId` selects scoped work.
Coordinator work reads expose only its current unexpired leases; other resource
reads cover Assistant-owned state. Memory reads require a current leased
`workId` and allow only that work, its topic, exact current source messages, and
valid memories whose sources fit the frozen set. Other resources are forbidden
to memory except receipts. Filtered pages may be empty while `hasMore` is true:
continue with the returned cursor.

Receipt reads require exact `workId`, but not a live lease:

```json
{"role":"coordinator","epoch":1,"resource":"receipts","workId":"WORK_ID"}
```

They return `{workId,state,epoch,inputVersion,result}`; `result` is non-null only
for `done` work. Use this after uncertain submissions instead of making a new
decision. A current bound role may inspect its prior-epoch work receipt.

Both result tools require this proof, using values from the claim:

```json
{"requestId":"decision-1","workId":"WORK_ID","epoch":1,"token":"LEASE_TOKEN","inputVersion":1,"stateVersion":0}
```

Proof fields are required, not inferred. Coordinator state must still match the
global `stateVersion`; stale state/leases require fresh claim/read. Memory
commits validate the entire frozen source set, not only cited entries.

### Coordinator decision and topic routes

`assistant_decide` adds `topic`, `reason`, and `action` to proof:

```json
{
  "requestId":"decision-1",
  "workId":"WORK_ID",
  "epoch":1,
  "token":"LEASE_TOKEN",
  "inputVersion":1,
  "stateVersion":0,
  "topic":{"title":"Project planning","independent":true},
  "reason":"The input concerns this separate project topic.",
  "action":{"kind":"route","sessionIds":["RECEPTION_SESSION"],"routeVersion":0}
}
```

The numbers/IDs above are illustrative; use actual claimed values. `topic` is
`{[id],[title],[domain],[independent],[relatedTo]}`. For an existing topic, use its
`id` (must not be archived); other supplied topic attributes do not patch it.
A new topic requires nonempty `title` (at most 240) and boolean `independent`;
optional `domain` is at most 240 characters or null and `relatedTo` contains at
most 20 existing topic IDs.

| Action | Fields and constraints |
| --- | --- |
| `route` | User input only: 1–8 unique enabled direct `sessionIds`, current nonnegative `routeVersion`, optional `answerQuestionId`, optional `context` (at most 16,000). |
| `clarify` | User input only: required `text`; publishes a clarification, no native send. |
| `publish` | New nonhistorical native output only: optional `text`; omitted preserves source wording. Native asks always preserve original question/options/restrictions. |
| `suppress` | Output only: required nonempty `reason` (at most 4,000); no public output publication. |

Read routes through `assistant_read(resource:"routes")` or management
`GET /routes`: each record is `{id:<topicId>,sessionIds,version,evidence}`.
An absent route has version zero. An unanchored route decision records the
targets and increments version; there is no separate route-update endpoint.
Explicit replies retain their original target and do not replace the topic
route. Changing reception schedules handoff work and includes bounded,
source-attributed historical context; it is not a topic switch or new user
authorization. Background output classification never changes foreground.

Only evidenced complete primary native replies become output work: a durable
`assistant.message` with empty `toolRequests`, a known primary turn start, and
a primary turn end directly referring to it. Arbitrary text, idle, tool output,
and subagent output do not qualify. Completion of text is not proof that the
work described succeeded; delivery/reply correlation remains unknown.

### Native questions and answers

Read `/questions` or scoped MCP questions for the exact native request:
`requestId`, `question`, optional literal string `choices`, and `allowFreeform`.
Published question text includes those choices and the free-text rule, and
`anchorId` identifies the original question/session. Submit an answer as normal
user input with that anchor:

```json
{"requestId":"answer-1","text":"Proceed","replyTo":"QUESTION_ANCHOR_ID"}
```

The coordinator routes to that one original reception with the current topic
route version. For unanchored input, `answerQuestionId` is an Assistant question
record ID, not the native request ID, and is allowed only for one uniquely
matching pending literal choice. Otherwise clarify; never guess authorization.
Ordinary unanchored routing to a session with pending questions is rejected.

An exact unique choice sets native `wasFreeform:false`; other text sets true
only if `allowFreeform !== false`. Duplicate literal choices are rejected.
Answers use native `respondAsk`, never a prompt, and retain literal text without
context/risk suffixes. The runtime rechecks the original request immediately
before answering; missing, changed, or stale questions cannot redirect to a new
request. Acceptance is not proof of the subsequent model outcome.

### Memory result

`assistant_remember` adds `entries` (0–100) to the same proof. Each entry is
`{kind:"confirmed"|"reported"|"inferred",text,sources}` with nonblank text of at
most 16,000 characters and 1–200 exact source references:

```json
{"messageId":"SOURCE_MESSAGE_ID","version":1,"assignmentVersion":1}
```

Cite only sources supplied by the work. The batch commits atomically and returns
`{topicId,kind,version,through,entries}`. Topic switches schedule incremental
memory for the departed topic; later arrivals remain dirty. `handoff` work
stores a separate summary available through its work receipt, not ordinary
`/memories`, and does not advance normal memory coverage. Reports of success
remain `reported`, not user-confirmed facts. Drain work until claim returns null.

See [architecture and reliability](architecture.md) for persistence, provenance,
shared-context risk, and failure boundaries, and the
[coordinator](../roles/coordinator.md) / [memory](../roles/memory.md) instructions
for role behavior.

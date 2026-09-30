# API and role setup

Assistant uses the public Cockpit module API. All paths below are relative to
its authenticated, digest-bound module HTTP base. No route accepts a host
credential, private runtime handle or caller-selected MCP identity.

See [architecture](architecture.md) for topic, batching, native correlation and
durability semantics, and [interface](interface.md) for conversation projection.
The strict schemas in `src/schema.ts` and `src/attachments.ts` are authoritative.
Retired coordinator tools and routes are not compatibility aliases.

## Setup and transition

Select `coordinator` and `memory` on separate sessions using native role
controls. Saved-role notifications register carriers; readiness separately
checks applied role definitions, expected model/directory and resources.
Protocol 2 must actually be applied. A package publication does not reload
loaded carriers or rewrite their native context.

`GET /readiness` is passive. `POST /roles/activate` explicitly loads only
registered, unloaded carriers selected by a captured binding vector. It does
not create replacements, reload loaded sessions or repair disabled resources.
The frontend uses this operation on opening when appropriate. The operator
must handle pending role changes through normal host controls.

Schema 2 rejects schema 1. There is no automatic deletion or data migration;
replacing old generated state is a separately authorized operator action.
Use isolated data roots for development. Never modify installed package bytes.

## HTTP conventions

Mutations use JSON and strict bodies. Except for the stream, successful reads
return JSON. Known errors are `{error:{code,message,status,...}}` with their
HTTP status. Stable request IDs make retries inspectable and idempotent;
changed content under the same request ID conflicts. An unknown effect is not
permission to resend.

| Method and path | Body or query | Result |
| --- | --- | --- |
| `POST /messages` | `{requestId,text,attachments?}` | Saved original message and coordinator work. |
| `GET /inputs/:requestId` | No query | Original input plus bounded current work and deliveries. |
| `GET /state` | No query | Config, registered bindings and publication cursor. |
| `GET /readiness` | No query | Fresh passive role/readiness observations. |
| `POST /roles/activate` | `{requestId,bindings:[{role,sessionId,epoch}]}` | Durable exact-binding activation receipt. |
| `POST /roles/bind` | `{requestId,role,sessionId,expectedEpoch,definitionVersion:"2",expectedModelId}` | Explicit recovery binding operation. |
| `POST /sessions` | `{requestId,cwd,role?}` | Explicit operator creation, not a coordinator tool. |
| `GET /sessions/:id/inspect` | No query | Passive exact-session native metadata. |
| `POST /sessions/:id/history/recover` | `{requestId,maxPages,evidence}` | Explicit bounded historical resynchronization receipt; see below. |
| `GET /operations/:id` | No query | Durable operation receipt, or 404. |
| `PATCH /config` | `{requestId,config:{defaultCwd?,maxReceptions?}}` | Persisted parsed configuration. |
| `GET /topics` | `after`, `limit` | Flat topic records. |
| `GET /messages` | `after`, `limit` | Assistant input and business reply/question originals, not native user history. |
| `GET /receptions` | `after`, `limit` | Ordinary destination metadata and reader progress. |
| `GET /questions` | `after`, `limit` | Stored questions and native answer state. |
| `GET /deliveries` | `after`, `limit` | Independent native effects and correlation receipts. |
| `GET /operations` | `after`, `limit` | Local idempotency and preparation operations. |
| `GET /memories` | `after`, `limit` | Versioned source-bound memory. |

Table reads default to `after=0,limit=50`, with limits from 1 to 100.
`defaultCwd` must be absolute and defaults to the home directory; newly created
topic sessions use the host's native model default. New topic definitions do
not create sessions until dispatch needs one.

Inputs strictly reject `topicId`, `replyTo` and unrecognized fields. Empty text
requires at least one attachment. Native file, directory, selection and blob
descriptors are validated, bounded and preserved; preview URLs are not file
paths. Attachment-bearing originals are isolated from other input batches.

### Conversation projection

| Method and path | Meaning |
| --- | --- |
| `GET /timeline?limit=50` | Latest window in ascending publication sequence. |
| `GET /timeline?before=N&limit=50` | Exclusive older window. |
| `GET /timeline?after=N&limit=100` | Exclusive forward catch-up. |
| `GET /timeline/items/:sequence` | Current projection of one durable publication. |
| `GET /timeline/stream?after=N` | SSE publication projections; `Last-Event-ID` takes precedence. |

`before` and `after` are mutually exclusive. Pages expose bounded continuation
and a global watermark, not proof of reading or gap-free native history.
Attribution patches the original visible reply without changing its publication
identity. Original publications remain immutable when a corrected source changes
its current projection. Internal diagnostic publications advance cursors but do
not become chat bubbles.

## Coordinator MCP

`POST /mcp` supports JSON-RPC initialization, ping, tool listing and calls.
Supported protocol versions are `2025-11-25`, `2025-06-18` and `2025-03-26`.
Tool errors use `isError:true`; missing/invalid host invocation identity cannot
be replaced by a tool argument. Only the currently registered, ready primary
role carrier can perform its role's operations.

The service supplies new natural-language batches containing original source text
and relevant session names/IDs, not the entire conversation again. Source quotations
remain evidence, not instructions. Coordinator operations apply to the current
hidden batch; they do not accept queue proofs. Native MCP tool-call identity
and wake receipts establish the actual originating batch, not a model-supplied ID.

| Tool | Arguments |
| --- | --- |
| `assistant_topics` | `{after?,limit?}` |
| `assistant_topic` | `{topicId?,title,content,archived?}` |
| `assistant_map` | `{topicId,sessionId}`; null clears the mapping. |
| `assistant_sessions` | `{after?,limit?}` |
| `assistant_history` | `{sessionId,cursor?}` |
| `assistant_dispatch` | `{items:[{topicId,prompt}]}` |
| `assistant_attribute` | `{items:[{messageId,topicId}]}` |
| `assistant_clarify` | `{text}` |

Dispatch contains 1 to 100 items, each with exactly two fields. It freezes
independent deliveries and the original attachments transactionally. Native
acceptance is not coordinator quality approval or receiver completion.

History reads one persisted native page, backward, with at most 16 events.
They neither load sessions nor import their messages into Assistant.
Attribution only applies to replies supplied in the batch. It adds a topic
header to text already shown, never rewrites or republishes the response.

Native answers retain exact wording, including whitespace. Exact choices must
match literally; otherwise freeform must be allowed. Native ask routes reject
attachments and stale request identities without silently changing delivery mode.

## Memory MCP

Memory uses its existing source-bound proof protocol, independent of coordinator
batches:

| Tool | Arguments |
| --- | --- |
| `assistant_memory_claim` | `{role:"memory",epoch,workId?}` |
| `assistant_memory_read` | `{role:"memory",epoch,workId,resource,after?,limit?}` |
| `assistant_remember` | `{requestId,workId,epoch,token,inputVersion,stateVersion,entries}` |

Read resources are `work`, `topics`, `messages` and `memories`, filtered to the
claimed work and its exact source versions. Entries contain
`{kind,text,sources:[{messageId,version,assignmentVersion}]}`; kind is
`confirmed`, `reported` or `inferred`. A changed source invalidates stale proofs.
The coordinator cannot use these tools to claim or recover its own work.

## Diagnosis

### Explicit native history resynchronization

An expired ordinary-session cursor pauses that reader and records `gap` in
`GET /receptions`. Operators can explicitly resynchronize the existing, loaded
ordinary session through `POST /sessions/:id/history/recover`, for example:

```json
{
  "requestId": "inspect-gap-1",
  "maxPages": 2,
  "evidence": "Inspected the expired cursor; acknowledge that bounded recovery may leave older history unread."
}
```

`maxPages` is an integer from 1 to 10; each native page is bounded to 64 events.
`evidence` must contain 1 to 4000 characters after trimming whitespace. The body is
strict and accepts no caller-chosen cursor. Internal carriers are excluded.
The operation does not load sessions, send messages or ask the coordinator to
manage work proofs.

The result is an operation receipt with `state` and `result`; inspect it again
through `GET /operations/history-recovery:<requestId>`. Same-input replay returns
the saved receipt without reading again; changed input under that ID conflicts.
On success, the returned bootstrap's native forward cursor replaces the expired
one atomically and the reader resumes. Imported replies are historical, deduplicated,
and never published or classified as new output. New events after that forward
boundary remain ordinary live replies. `olderHistoryRemaining` is not a promise
of gap-free history.

If a later page fails, earlier historical imports and progress may remain saved,
but the original forward cursor and gap are not replaced. The operation records
`unknown`; inspect its progress before explicitly authorizing another request ID.
This is bounded administrative recovery, not automatic all-history import or a
retired coordinator recovery tool.

Inspect the existing input, delivery or operation receipt before taking another
action. `calling` after process recovery becomes `unknown`, never automatically
pending. A missing session, expired cursor, rejected native answer and unknown
native effect are distinct facts; none permits silent replacement or replay.
See [architecture](architecture.md#durable-effects-and-correlation).

Normal conversation does not require technical receipt management. Developer
inspection does not establish model success, and no module API operation grants
deployment, production cleanup or runtime restart authority.

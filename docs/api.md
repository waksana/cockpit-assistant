# API and role setup

Assistant uses the public Cockpit module API. All paths below are relative to
its authenticated, digest-bound module HTTP base. No route accepts a host
credential, private runtime handle or caller-selected MCP identity.

See [architecture](architecture.md) for topic, batching, native correlation and
durability semantics, and [interface](interface.md) for conversation projection.
The strict schemas in `src/schema.ts` and `src/attachments.ts` are authoritative.
Retired coordinator tools and routes are not compatibility aliases.

## Setup and transition

Select `coordinator` using native role controls. Readiness separately checks
the actual role and resources; selection does not establish readiness. This
version does not run or require memory. A package publication does not reload
loaded carriers or rewrite their native context.

`GET /readiness` is passive. `POST /roles/activate` explicitly loads only
registered, unloaded carriers selected by a captured binding vector. It does
not create replacements, reload loaded sessions or repair disabled resources.
The frontend uses this operation on opening when appropriate. The operator
must handle pending role changes through normal host controls.

Schema 3 requires exactly `messages`, `topic_messages` and `topics`.
Schema 1 and schema 2 are rejected without deleting or migrating their data;
replacing old generated state is a separately authorized operator action, not an
operation provided by this module.
Use isolated data roots for development. Never modify installed package bytes.

## HTTP conventions

Mutations use JSON and strict bodies. Except for the stream, successful reads
return JSON. Known errors are `{error:{code,message,status,...}}` with their
HTTP status. Stable request IDs make retries inspectable and idempotent;
changed content under the same request ID conflicts. An unknown effect is not
permission to resend.

| Method and path | Body or query | Result |
| --- | --- | --- |
| `POST /messages` | `{requestId,text,attachments?}` | Saved original message, awaiting coordinator processing. |
| `GET /inputs/:requestId` | No query | Original input plus its topic-message results and delivery state. |
| `GET /state` | No query | Host-supplied config, observed coordinator role, `schemaVersion:3`, message revision watermark in `publicationCursor`, and `timelineProtocol:"message-snapshots-v1"`. |
| `GET /readiness` | No query | Fresh passive role/readiness observations. |
| `POST /roles/activate` | `{requestId,bindings:[{role:"coordinator",sessionId}]}` | Temporary exact-session activation receipt; one coordinator only. |
| `POST /roles/bind` | `{requestId,role:"coordinator",sessionId}` | Validate the actual Host role carrier; not a persistent binding override. |
| `POST /sessions` | `{requestId,cwd,role?}` | Explicit operator creation, not a coordinator tool. |
| `GET /sessions/:id/inspect` | No query | Passive exact-session native metadata. |
| `GET /operations/:id` | No query | Current-process setup receipt, or 404; not a durable effects ledger. |
| `PATCH /config` | `{requestId,config:{defaultCwd?}}` | Rejected with `HOST_CONFIG_REQUIRED`; configuration belongs to the host. |
| `GET /topics` | `after`, `limit` | Flat topic records. |
| `GET /messages` | `after`, `limit` | Assistant input and business reply/question originals, not native user history. |
| `GET /topic-messages` | `after`, `limit` | Source/topic results; user rows additionally include per-prompt delivery facts. |
| `GET /receptions` | `after`, `limit` | Ordinary destination metadata queried from Host, not stored reader progress. |

Table reads default to `after=0,limit=50`, with limits from 1 to 100.
`defaultCwd` must be absolute and defaults to the home directory; newly created
topic sessions use the host's native model default. New topic definitions do
not create sessions until dispatch needs one.

Set `defaultCwd` in the Assistant entry's `config` object in the host-owned
`modules/config.json`, preserving its selected version, digest and enabled
fields. The host passes configuration on the next cold start, as documented in
the [host storage/config contract](https://github.com/waksana/cockpit/blob/main/docs/module-contract.md#storage-config).
The module does not write that file, maintain a second configuration in SQLite,
or promise hot application. Its public SDK supplies read-only configuration,
not a configuration mutation capability.

Inputs strictly reject `topicId`, `replyTo` and unrecognized fields. Empty text
requires at least one attachment. Native file, directory, selection and blob
descriptors are validated, bounded and preserved; preview URLs are not file
paths. Attachment-bearing originals are isolated from other input batches.

### Conversation projection

| Method and path | Meaning |
| --- | --- |
| `GET /timeline?limit=50` | Latest message window in stable ascending display `sequence`. |
| `GET /timeline?before=N&limit=50` | Exclusive older window by display `sequence`. |
| `GET /timeline?after=N&limit=100` | Current message snapshots changed after revision N, in revision order. |
| `GET /timeline/items/:sequence` | Current projection of the message at that stable display position. |
| `GET /timeline/stream?after=N` | SSE message snapshots with revision event IDs; `Last-Event-ID` takes precedence. |

`before` and `after` are mutually exclusive. Pages expose bounded continuation
and a global watermark, not proof of reading or gap-free native history.
Each item has a stable message `id` and display `sequence`, plus a changing
`snapshotRevision`. SSE retains the event name `publication`, but its event ID
is `snapshotRevision`, not the display sequence. Revisions may skip when a newer
snapshot supersedes an unread update; they need not be contiguous.

Initialize the update cursor from the page's `watermark`. For forward pages,
advance using `cursor`, merging newer snapshots by message identity while
retaining display order. Attribution, clarification and question
state patch the original message in place without creating another bubble or
unread message. There is no persistent publication log or diagnostic message
stream. Native/session failures remain visible through the host error reporting
and readiness surfaces.

## Coordinator MCP

`POST /mcp` supports JSON-RPC initialization, ping, tool listing and calls.
Supported protocol versions are `2025-11-25`, `2025-06-18` and `2025-03-26`.
Tool errors use `isError:true`; missing/invalid host invocation identity cannot
be replaced by a tool argument. Only the currently registered, ready primary
role carrier can perform its role's operations.

The service supplies one eligible original message and its clarification record,
with relevant source names/IDs, not the entire conversation again. Source
quotations remain evidence, not new user authorization. Coordinator operations
apply to that source, not a multi-message batch. Runtime/native invocation
identity must prevent stale tools from modifying a different message.

| Tool | Arguments |
| --- | --- |
| `assistant_topics` | `{after?,limit?}` |
| `assistant_sessions` | `{after?,limit?}` |
| `assistant_history` | `{sessionId,cursor?}` |
| `assistant_source` | `{messageId}` |
| `assistant_complete` | `{messageId,topics?,items}`; complete definitions, mappings and results for one original. |
| `assistant_clarify` | `{messageId,question,choices?,allowFreeform?}` |

`assistant_complete.topics` contains affected definitions:
`{topicId,title,content,archived?,sessionId?}`. A new definition uses an explicit,
stable `topicId`. Existing definitions are read with `assistant_topics`; unchanged
definitions need not be resubmitted. A new reply topic defaults to its original
source session, while existing topics do not adopt a new speaker automatically.
An explicit handoff must identify an actual ordinary target session.

`items` contains 1 to 100 topic results. For a user original each item is
`{topicId,prompt}`; for a session reply or question it is `{topicId}` with no
copied or rewritten body. Service saves all results, definition/mapping changes
and the processed flag transactionally before any outgoing native call. Native
acceptance is not coordinator quality approval or receiver completion.

History reads one persisted native page, backward, with at most 16 events,
plus that session's actual current ask and known topic associations. They
neither load sessions nor import their messages into Assistant.
Attribution only applies to the current original reply. It adds a topic
header to text already shown, never rewrites or republishes the response.

Native answers retain exact wording, including whitespace. Exact choices must
match literally; otherwise freeform must be allowed. Native ask routes reject
attachments and stale request identities without silently changing delivery mode.

## Message-local clarification

Clarification questions and answers belong to their original message. They do
not create independent conversation rows or a new topic input.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /messages/:messageId/clarifications/:clarificationId` | None | Current `{messageId,clarification}` record for exact answer inspection. |
| `POST /messages/:messageId/clarifications/:clarificationId` | `{requestId,answer}` | Saved answer on that exact clarification; does not mark the original processed. |

The frontend retains the exact request on an unknown result and reads this
record instead of resending. A successful answer must match its original
message, clarification, request ID and text. Stale questions and conflicting
answers fail explicitly. The waiting state ends after the answer is saved, but
the original remains unprocessed until the coordinator saves its topic results.
The original body is never overwritten.

## Diagnosis and limits

No offline native-history resynchronization or memory extraction API is provided.
The coordinator's passive native-chat reads are context only, not import or replay.
Each user-origin topic result retains its own delivery outcome. An uncertain
native call is not automatically returned to pending or repeated. Rare stuck
questions and handoffs can be handled directly in their source sessions.
See [architecture](architecture.md#delivery-facts-and-correlation).

Normal conversation does not require technical receipt management. Developer
inspection does not establish model success, and no module API operation grants
deployment, production cleanup or runtime restart authority.

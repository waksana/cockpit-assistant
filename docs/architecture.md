# Architecture and reliability

## Ownership

One activation manages one Assistant space in its module-private `dataRoot`.
Cockpit authenticates digest-bound HTTP routes and supplies the main caller's
identity to MCP. Assistant is trusted same-user code, not a sandbox or a new
authorization system. It never uses private SDK handles, native-home scans or
Task state to implement conversations.

The native session directory supplies bounded metadata for choosing destinations.
It is not a chat archive. Assistant stores its own input, topic-specific results,
new ordinary primary replies and native questions, and necessary progress. Native
session user messages, including forwarded prompts, are not imported as user
speech or coordinator work. The coordinator can inspect native history on demand through the
public `session/chat` API without loading the session or importing that history.

Select `coordinator` through Cockpit's normal role controls. Role selection does
not establish readiness. Actual applied roles, resources and native availability
remain host-owned; an unloaded carrier is not missing. Internal carriers are
never ordinary destinations or sources of business replies. This version does
not run a memory role or require one before accepting conversation.

## Three-table persistence

The product model is topics and conversation. SQLite has exactly three application
tables; SQLite's internal tables and indexes are not application records:

| Table | Durable responsibility |
| --- | --- |
| `messages` | Original conversation, source/native identity, attachments, stable display order, processed flag and message-local clarification. |
| `topic_messages` | One original-message/topic association per result. User-origin results additionally contain the split prompt and its own delivery state/receipt. Session-origin results refer to the original without copying or rewriting it. |
| `topics` | Flat topic definition and its current session mapping. |

One original message may produce several topic results. Each result belongs to
one topic, but a topic can have many results. `processed` means the complete
semantic result has been saved, not that every outgoing prompt was accepted or
the underlying task finished. Unanswered clarification leaves the original
unprocessed but not eligible for repeated coordinator calls.

There is no durable batch, separate work queue, publication log, session mirror,
native-event archive, memory store or generic metadata table. Delivery facts
belong to the actual outgoing topic message, not a separate effects system.
Module configuration belongs to the host configuration. Session state and
current native questions are queried through public host APIs.

## Flat topics and one current mapping

A topic has a stable ID, a title, content and zero or one current
ordinary session. There is no parent, tree, foreground topic or implicit title
hierarchy. A title such as `Xinjiang trip - hotels` is still an ordinary flat
topic. Several topics may share a session, and a mapping can change without
migrating its history. Creating a topic alone never creates a native session.

The coordinator updates topic definitions and mappings, reviews history only
when necessary, splits user intent faithfully and attributes replies. It does
not create sessions, manage deliveries, claim coordinator work or adjudicate
the quality of another session's response.

For one user original, a semantic result supplies topic-specific prompts:

```json
{
  "messageId": "source-message-id",
  "items": [
    { "topicId": "travel", "prompt": "Compare the two travel dates." },
    { "topicId": "hotel", "prompt": "Find hotels near the station." }
  ]
}
```

The service supplies the original `messageId`; topic identity and faithful
content are the semantic result. Work, leases, epochs, runtime versions and wake
receipts are not model-managed business steps.
Generated prompts may split or clarify the user's request but cannot add
authorization, contradict the request or replace its saved original.

## Original conversation before classification

```text
Assistant input -> durable original + visible user message
                          |
                   one-message classification
                          |
             topic/mapping + two-field dispatch
                          |
                 user-origin topic_messages
                          |
                  ordinary session replies
                          |
             original reply + visible reply message
                          |
                  one-message attribution
                          |
             patch existing message's topic header
```

Each user original appears once and never has a topic header, even when it
produces multiple prompts. Business replies appear before classification.
Attribution adds a plain title listing the related topics in place, without changing
the body, timestamp, message identity or unread count. It neither publishes a
second reply nor asks the responding session to rewrite one. Background
generated prompts are topic-message delivery records, not user chat bubbles.

The coordinator processes one eligible original at a time. There is no
multi-message batch. Service saves the complete set of topic results and the
original's processed flag in one SQLite transaction, then sends individual
user-origin results. Original attachments accompany each of that user's split
prompts. Classification does not require public claim, lease or ACK tokens.
User input and earlier native observations share the same short validation and
persistence boundary, so a delayed metadata read cannot save an answer ahead
of its already-observed question. Coordinator execution and native delivery
waits stay outside this boundary.

Native acceptance is not business completion. A failed recipient does not cause
the already-classified original to be split again or another accepted prompt to
be resent. Exact invocation identity prevents late coordinator tools from
applying to a different message. Idle, turn-end and elapsed time do not establish
the outcome of an uncertain native call. Rare unresolved calls can require
manual handling in the original session; this module does not implement an
automatic retry, skip, reassignment or general recovery framework.

Only the current original and necessary context are supplied. The coordinator
can consult stored messages or related native chat when a topic is unclear;
those reads do not become new inputs. Empty queues wait for events, not model
polling. The model's long-term context is not the durable source of topic facts.

## Message-local clarification

A clarification belongs to the original message. Service saves the question and
waiting state on that row, leaves it unprocessed and displays a question box
under its original body. Waiting rows are not repeatedly classified. Other
eligible originals can continue through the one-message loop.

The box submits to its exact message and clarification identity. Service keeps
the question and answer history without replacing the original text or creating
an independent user message. Answering makes that original eligible again; it
does not mark it processed. The coordinator receives the original plus its
clarifications, and the processed flag advances only with a complete saved
result. Old or conflicting answers cannot target a newer clarification.

## Delivery facts and correlation

SQLite uses WAL and `synchronous=FULL`. A Linux abstract-socket lease prevents
two cooperating activations from operating the same store. Original input and
its stable request receipt commit before acceptance. Changed request bodies
conflict; a retry of the same request returns its original receipt.

| Delivery state | Meaning |
| --- | --- |
| `pending` | No native message call has started. |
| `calling` | Durable call intent exists; the native call may be in progress. |
| `accepted` | Native acceptance was observed, not reading or completion. |
| `rejected` | A precondition or explicit native rejection prevented delivery. |
| `unknown` | The effect may have happened; automatic resend is forbidden. |
| `cancelled` | This local operation has been explicitly abandoned. |

Each outgoing topic message has its own delivery facts. One destination's failure
does not repeat another destination's accepted prompt. Recovery turns a
crashed `calling` state into `unknown`, not `pending`. This is deliberately not
a cross-system exactly-once promise.

An unmapped topic's first delivery creates a session using configured
`defaultCwd` (the home directory by default) and the host's native default model.
The actual new ID is saved before further observation or delivery. Uncertain
creation blocks replacement creation. An unloaded mapped session is loaded by
its existing ID; a loaded busy session receives normal enqueue delivery.
Neither path changes models, reloads loaded sessions or interrupts native work.
Shared sessions receive a short focus/splitting suggestion, not a fabricated
authorization or automatic migration.

Preparing a session is separate from calling `prompt`. A lost load response
does not establish an unknown prompt. Bounded preparation can read the same
native identity and continue the still-unsent message. Missing or newly
internal targets fail explicitly instead of silently creating replacements.

Business reply ingestion is live-only, not gated by delivery correlation.
Ordinary primary response segments and native questions received while service
runs are eligible, including background continuations. Native user messages,
internal role carriers, subagent transcripts, reasoning and tool payloads are
not the feed. Stable native identity deduplicates repeated notifications.
Messages from service downtime are not backfilled, and no per-session history
cursor is stored.

Internal coordinator calls have a different boundary. The host's
native `toolCallId` joins the exact originating `assistant.message.toolRequests`
and `interactionId`, then the `user.message.data.messageId` matching the saved
wake receipt. Missing, conflicting or stale invocation provenance is rejected;
an in-memory current-source pointer alone never authorizes a tool. This control evidence does not
ingest native user text into Assistant. `parentId` is chronological, not causal.
Receipt availability and native scheduling readiness do not imply interaction
completion, and idle/turn-end events do not end business reply observation.

## Questions and attachments

A business session's native question retains its exact request identity, choices and
freeform restrictions. For a topic's current session, service checks the
host's current pending question and its topic association. A user prompt for
that topic answers that current question when present; otherwise it is sent as
an ordinary prompt. The backend rechecks the same question
before sending. Exact choices remain choices; allowed freeform answers retain
the user's wording. Attachments are rejected for native answers without being
silently discarded or bypassed through a normal prompt. All ordinary business
questions are eligible; they need not prove ownership by a particular Assistant
prompt. Historical questions in retired sessions are not candidate answers for
the current mapping. A rare stuck handoff can be handled directly in its
original session instead of adding historical-question arbitration.

Native attachment descriptors are preserved in the immutable original,
versioned source and independent deliveries. Preview URLs are not native
paths. Acceptance never proves that a path still exists or that a model read
or supports the attachment. The public host draft remains the owner of editable
text, attachments, keyboard behavior and compatible Speech/File enhancements.

## Schema and role transition

Schema 3 uses the three-table model. Schema 1, schema 2 and a mismatched
schema 3 layout are rejected before modifying the database. There is no automatic
deletion, migration or reset. Replacing old state is a separately authorized
operator action, not part of package installation or startup.
Never point development or acceptance runs at a production data root.

The old release descriptor incorrectly treated target-schema tables as
preservation projections over the source database. In particular, querying
`batches` before upgrading schema 1 fails because that table does not exist.
Declaring no preservation projections avoids that particular query but does
not itself authorize a schema transition. Destructive reset must not be
declared as a nondestructive migration. See [releases](releases.md) for the
deployment contract and its availability boundary.

The current coordinator role has no claim/lease/wake-ACK protocol and no memory
dependency. Merely publishing a package does not apply new instructions to an
already-loaded carrier. Use normal host role application/loading controls and
then inspect actual readiness; do not silently replace registered carriers.

The database and WAL require SQLite-aware backups. There is no automatic
retention, arbitrary corruption recovery, or claim that deleting Assistant
state makes a native model forget its conversation.

## Retirement of the previous protocol

| Product requirement | Disposition |
| --- | --- |
| D01: one topic per input | One original may dispatch to several flat topics. |
| D02: one decision per claimed work | One original produces one complete set of topic results. |
| D03: full-text multi-target forwarding | Topic-specific prompts preserve the original separately. |
| D04: classification before visibility | Originals appear first; replies gain headers later. |
| D05: coordinator proof/lease/version | Removed from coordinator business tools. |
| D06: model-managed session creation | Service creates only when a mapped destination is needed. |
| D07: wake ACK | No coordinator ACK protocol. |
| D08: old rejection blocks new work | Failures remain explicit; no general retry/recovery framework. Rare stuck work is handled in its original session. |
| D09: per-event reminders and empty polling | One eligible original at a time; unanswered clarification waits on that message and empty queues do not call the model. |
| D10: metadata-only routing | Coordinator submits faithful topic-specific prompts. |
| D11: publish/rewrite gate | Attribution only; original replies are already visible. |
| D12: route context and handoff procedure | Replaced by topic content and current session mapping. |
| D13: `replyTo` | Rejected at the input boundary; native asks retain real identity. |
| D14: foreground-centered memory | No foreground pointer or memory dependency in this version. |
| D15: normal technical receipt UI | Receipts remain diagnostic, not normal conversation controls. |
| D16: topic tree | Flat records only. |
| D17: old and new protocols together | Three-table schema and one coordinator protocol; no compatibility execution path. |

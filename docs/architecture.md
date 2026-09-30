# Architecture and reliability

## Ownership

One activation manages one Assistant space in its module-private `dataRoot`.
Cockpit authenticates digest-bound HTTP routes and supplies the main caller's
identity to MCP. Assistant is trusted same-user code, not a sandbox or a new
authorization system. It never uses private SDK handles, native-home scans or
Task state to implement conversations.

The native session directory supplies bounded metadata for choosing destinations.
It is not a chat archive. Assistant stores its own input, deliveries, all new
ordinary primary replies and native questions, and necessary progress. Native
session user messages, including forwarded prompts, are not imported as user
speech or coordinator work. The coordinator can inspect native history on demand through the
public `session/chat` API without loading the session or importing that history.

Select `coordinator` and `memory` through Cockpit's normal role controls.
Successful role saves register carriers, but do not establish readiness.
Registration epochs invalidate retired carriers. Readiness checks actual applied
roles, resources and native availability; an unloaded carrier is not missing.
Internal carriers are never ordinary destinations.

## Flat topics and one current mapping

A topic has a stable ID and color, a title, content and zero or one current
ordinary session. There is no parent, tree, foreground topic or implicit title
hierarchy. A title such as `Xinjiang trip - hotels` is still an ordinary flat
topic. Several topics may share a session, and a mapping can change without
migrating its history. Creating a topic alone never creates a native session.

The coordinator updates topic definitions and mappings, reviews history only
when necessary, splits user intent faithfully and attributes replies. It does
not create sessions, manage deliveries, claim coordinator work or adjudicate
the quality of another session's response.

One dispatch submits all inputs in the current batch as:

```json
{
  "items": [
    { "topicId": "travel", "prompt": "Compare the two travel dates." },
    { "topicId": "hotel", "prompt": "Find hotels near the station." }
  ]
}
```

Every item has exactly `topicId` and `prompt`. IDs for work, leases, epochs,
versions, receipts or destination sessions do not belong in this payload.
Generated prompts may split or clarify the user's request but cannot add
authorization, contradict the request or replace its saved original.

## Original conversation before classification

```text
Assistant input -> durable original + visible user message
                          |
                   hidden input batch
                          |
             topic/mapping + two-field dispatch
                          |
                 independent durable deliveries
                          |
                  ordinary session replies
                          |
             original reply + visible reply message
                          |
                  hidden attribution batch
                          |
             patch existing message's topic header
```

Each user original appears once and never has a topic header, even when it
produces multiple prompts. Business replies appear before classification.
Attribution adds the stable topic color and title in place, without changing
the body, timestamp, message identity or unread count. It neither publishes a
second reply nor asks the responding session to rewrite one. Background
generated prompts are delivery records, not user chat bubbles.

Service-managed batches hold the actual work set. Text-only originals can be
coalesced; an input with attachments occupies its own batch. Those attachments
can accompany every topic prompt split from that one original. The coordinator
receives natural-language source context and uses business tools rather than
computational claim/lease/ACK tokens.

A native acceptance is not a completed batch. Saved business decisions complete
the work; neither a model turn ending nor a chronological event-parent chain
proves that a native interaction ended. Finished inputs are not dispatched again
because attribution or another output failed. Confirmed rejected deliveries and
unknown send outcomes retire their batches without replaying their effects.
Exact native tool identity prevents late work from applying to a newer batch.
An accepted batch with unfinished decisions remains pending: elapsed time,
idle or abort alone cannot establish its outcome. Slow or busy consumers do not
lose their input to a wall-clock deadline; an externally abandoned accepted
batch can therefore require explicit recovery rather than automatic completion.
Empty queues wait for new work, not model polling.

The persistent coordinator receives only new semantic batches, not a replay of
the entire Assistant conversation. Compact tool results retain necessary IDs,
saved changes and errors rather than repeating original bodies or prompts.

## Durable effects and correlation

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

Each topic prompt has an independent outbox record. One destination's failure
does not repeat another destination's accepted prompt. Recovery turns a
crashed `calling` record into `unknown`, not `pending`. This is deliberately not
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

Business reply ingestion is not gated by delivery correlation: every new
ordinary primary response segment is eligible, including later background
continuations. Native user messages, internal role carriers, subagent transcripts,
reasoning and tool payloads are not the conversation feed. Native event/message
identities deduplicate replay and retain minimal hashes rather than another
copy of the original body. Historical bootstrap records are not new replies.

Internal coordinator and memory calls have a different boundary. The host's
native `toolCallId` joins the exact originating `assistant.message.toolRequests`
and `interactionId`, then the `user.message.data.messageId` matching the saved
wake receipt. Missing, conflicting or retired-batch provenance is rejected;
the active batch alone never authorizes a tool. This control evidence does not
ingest native user text into Assistant. `parentId` is chronological, not causal.
Receipt availability and native scheduling readiness do not imply interaction
completion, and idle/turn-end events do not end business reply observation.

Expired business cursors pause observation until an operator uses the
[bounded history resynchronization API](api.md#explicit-native-history-resynchronization).
The explicit operation imports only bounded historical pages, preserves
deduplication, and changes the forward cursor only after successful completion.

## Questions, attachments and memory

A business session's native question retains its exact request identity, choices and
freeform restrictions. Once attributed to a topic, a prompt for that topic can
answer its unique pending question. The backend rechecks the same question
before sending. Exact choices remain choices; allowed freeform answers retain
the user's wording. Attachments are rejected for native answers without being
silently discarded or bypassed through a normal prompt. All ordinary business
questions are eligible; they need not prove ownership by a particular Assistant
prompt. An answer stays with the question's actual source session even if the
topic's current mapping changes.

Native attachment descriptors are preserved in the immutable original,
versioned source and independent deliveries. Preview URLs are not native
paths. Acceptance never proves that a path still exists or that a model read
or supports the attachment. The public host draft remains the owner of editable
text, attachments, keyboard behavior and compatible Speech/File enhancements.

Memory remains a separate source-bound extraction role. Work is per topic,
not driven by a foreground-topic switch. It retains its own source version
proofs and computational claims; these are not coordinator tools. A compound
original can supply context to several topics without implying that every
sentence belongs to every topic. Corrections and changed attribution invalidate
affected evidence. Reported and inferred memory is not silently promoted to
confirmed fact.

## Schema and role transition

Schema 2 replaces the old generated model. Schema 1 is explicitly rejected:
there is no migration, dual protocol, compatibility anchor or automatic
database deletion. Replacing old generated data is an operator-controlled
action, not a side effect of loading this module. Never point development or
acceptance runs at a production data root.

Role definition version 2 removes the coordinator claim/decide/create/wake-ACK
protocol. Merely publishing a package does not apply new instructions to an
already-loaded carrier. Use normal host role application/loading controls and
then inspect actual readiness; do not silently replace registered carriers.

The database and WAL require SQLite-aware backups. There is no automatic
retention, arbitrary corruption recovery, or claim that deleting Assistant
state makes a native model forget its conversation.

## Retirement of the previous protocol

| Product requirement | Disposition |
| --- | --- |
| D01: one topic per input | One original may dispatch to several flat topics. |
| D02: one decision per claimed work | One service-managed batch uses one dispatch array. |
| D03: full-text multi-target forwarding | Topic-specific prompts preserve the original separately. |
| D04: classification before visibility | Originals appear first; replies gain headers later. |
| D05: coordinator proof/lease/version | Removed from coordinator business tools. |
| D06: model-managed session creation | Service creates only when a mapped destination is needed. |
| D07: wake ACK | No coordinator ACK protocol. |
| D08: old rejection blocks new work | Definitive failures have bounded recovery, unlike unknown effects. |
| D09: per-event reminders and empty polling | Durable batches coalesce work and wait when empty. |
| D10: metadata-only routing | Coordinator submits faithful topic-specific prompts. |
| D11: publish/rewrite gate | Attribution only; original replies are already visible. |
| D12: route context and handoff procedure | Replaced by topic content and current session mapping. |
| D13: `replyTo` | Rejected at the input boundary; native asks retain real identity. |
| D14: foreground-centered memory | Per-topic source-bound memory. |
| D15: normal technical receipt UI | Receipts remain diagnostic, not normal conversation controls. |
| D16: topic tree | Flat records only. |
| D17: old and new protocols together | Schema 2 and role version 2; no compatibility execution path. |

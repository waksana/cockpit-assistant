# Architecture and reliability

## Ownership and trust

One activation manages one Assistant space under its module-private `dataRoot`.
Cockpit authenticates the enclosing digest-bound HTTP routes. Ordinary sessions
are observed automatically. A bounded public metadata directory establishes the
initial set; subsequent native/control events drive incremental updates, not a
repeated full catalog scan. Saved or applied coordinator/memory role identities
and registered internal carriers are excluded from ordinary conversation reads
and deliveries. There is no private SDK handle, native-home scan, Task dependency,
or shell-based adapter. IDs locate durable records in this Assistant space.

The module runs trusted code in the host process. Role instructions and MCP
checks are not an OS sandbox and do not remove Copilot's native permissions.
The host-observed `cockpit/invocation` metadata supplies main-session identity;
tool arguments cannot select it. Missing metadata, internal-agent calls,
retired epochs, unready bindings, and obsolete leases are rejected. The
installation trusts the host and its authenticated same-user operator, not
arbitrary HTTP clients claiming to be the host.

Normal role selection uses optional host permission and saved-role callbacks.
Assistant denies a second carrier while its registered session still exists;
unloaded does not mean missing. A successful save registers the carrier and
epoch without claiming readiness or preparing resources. Replayed notifications
do not increment the epoch or replace later registrations. Native save and module
registration are separate effects: a notification failure is not native rollback.
Readiness separately checks the actual model, directory, applied roles and
resources. An intentional recovery replacement retains compare-and-swap epochs;
late work cannot commit through a retired carrier.

The coordinator may request an ordinary session for a claimed user
input when no suitable existing target exists. Creation requires an explicit
working directory and a durable per-work receipt; it does not deliver the user
input or complete the work. The coordinator reads the result and makes a separate
validated route decision. Uncertain creation blocks another creation, including
under a new request ID. Internal role sessions are never created automatically.

## Coalesced role wakes

Work records are the actual backlog; a wake only asks one role to drain it.
Each `(role, bound session, epoch)` has at most one effective queued reminder.
Pending, calling, accepted-but-unconsumed and unknown wakes occupy it even when
the work set changes. Coordinator and memory slots are independent. No native
queue is scanned, edited or cleared, and identical user text is not deduplicated.

The notice carries its durable delivery ID as `wakeId`. The authenticated
role passes it on `assistant_claim` and continues until an unfiltered claim
returns null. That transaction releases only that exact notice while observing
the work queue, closing the new-work/drain race. Native acceptance is not
consumption. A claim without the ID still claims work but cannot release a
queued reminder; this avoids mistaking an unrelated role turn for consumption.
Only notices with recorded wake lifecycle facts participate in consumption.
There is no old-data conversion, compatibility reminder, or native queue cleanup;
unresolved native call uncertainty still prevents blind repetition.

A nonempty claim refreshes a five-minute computational drain lease. If draining
stops without an empty claim, the existing deadline timer can arrange one
subsequent reminder for remaining work after that lease expires. An unconsumed
accepted/unknown reminder still blocks further reminders; expiry never replays
its native effect. A consumed unknown wake keeps its uncertain native receipt
but has separate trusted consumption evidence. Old epoch claims cannot release
new bindings. Stop/restart preserves the durable slot and drain facts.
Pre-dispatch wake preparation is bounded like reception preparation but never
automatically loads internal role carriers; exhausted or explicitly rejected
wakes remain visible for the existing explicit wake recovery operation, rather
than generating new reminder IDs on every event.

## Durable processing

```text
user input -> inbox -> coordinator work -> atomic decision + outbox
                                                       |
                                                 native effect
                                                       |
ordinary-session cursor history -> evidenced output -> coordinator -> publication log
                                          topic switch -> memory work
```

SQLite uses WAL and `synchronous=FULL`. A Linux abstract-socket lease prevents a
second cooperating activation from recovering or dispatching the same store.
The database commit precedes an acceptance response. Message bodies, source
identities, classification versions, historical anchors, role epochs, leases, operation
fingerprints, and effect/publication state are durable. Sequence cursors are
database order, never UUID lexical order.

Routing commits an outbox decision, not successful delivery. For an ordinary
target the outbox reads the exact native identity, uses existing-only
`session/load` if unloaded, then rechecks identity, ordinary-role eligibility,
loaded/closing state and the original native question. Loaded busy sessions use
the existing `enqueue` path; preparation never reloads, interrupts, changes
resources/models/cwd, or loads unrelated directory entries. A new reception's
initial observation tail is established before dispatch when no prior gap exists.

Each load attempt has a separate durable `delivery-load:<delivery>:<attempt>`
operation. The delivery stays `pending` until the message call intent itself is
committed. A lost load acknowledgment is not an unknown prompt: recovery first
reads the same native ID and may continue the unsent message. Existing-only load
can resume bounded preparation without creating a replacement. Transitions and
unconfirmed preparation get at most three rounds, with persisted 1/2-second
deadlines driven by the runtime's existing deadline timer. Restart preserves
those facts. Shutdown stops further effects; an in-flight load may still finish.
Missing, forbidden, non-reception or newly internal targets fail explicitly.

Once all targets have definite terminal outcomes, a failed original input gets
one computational recovery of the same work, with failed and accepted target
facts. The coordinator can deliberately choose another valid target or clarify
a genuine semantic restriction. Accepted targets are never resent, even if
included in the new selection; pending/calling/unknown targets block rerouting.
A second failed decision remains visible in the original input receipt, not an
unbounded automatic decision loop. Changed input versions are not substituted
for frozen deliveries. Local receipt inspection includes preparation and delivery
errors without adding lifecycle chatter to the conversation.

User content includes native attachment descriptors alongside text. The
immutable input receipt, message versions, work source and each delivery retain
the same captured content, even if routing happens later or a target session
does not yet exist when input is accepted. A correction/reclassification cannot
silently replace pending attachments. Immutable publications retain their
recorded content version; the conversation projection can display a later
corrected source version, never a live draft. Native prompt dispatch
passes those descriptors directly; preview URLs are not native paths.

Attachment-only input is valid. The coordinator reads its descriptions through
the existing work/message protocol; internal wakes and memory extraction do
not receive copies of the files. Native ask answers reject attachments at both
decision and dispatch boundaries, without stripping them or falling back to a
prompt. Each target retains its independent delivery state, so another target's
failure never replays an accepted one. Accepting a description is not proof a
path remains readable or that a model supports or inspected its contents.

There is deliberately no cross-system exactly-once claim. Before each native
write, its fixed target and call intent are persisted:

| State | Meaning |
| --- | --- |
| `pending` | No native call has started; recovery may continue it. |
| `calling` | Durable call intent exists; the process may be inside the native call. |
| `accepted` | Native acceptance was observed; model reading or task completion is not implied. |
| `rejected` | A precondition or native rejection was observed; no silent alternative target is used. |
| `unknown` | The call may have happened; automatic resend is forbidden. |
| `cancelled` | An explicit disposition abandoned this local operation. |

Process recovery turns `calling` into `unknown`, not `pending`. Stable request
IDs return their original receipts; changed bodies conflict. A new role epoch
can re-claim computation, but cannot recreate accepted/unknown deliveries.
Resolving an uncertainty requires explicit evidence and preserves the original
operation. Resolution is an operator statement, not independent native proof.

The state does not survive arbitrary disk corruption or deleted backups.
Retain the database and its SQLite WAL together using SQLite-aware backup
procedures. No automatic retention, migration of user data, backup deletion,
or claim that another native model has forgotten content is implemented.

## Native observation

Observation/control hooks wake readers; hooks do not independently advance the
cursor. Whole durable native pages and their cursor commit together. Repeated
event IDs are checked and deduplicated. Ephemeral token/reasoning deltas are not
collected. Stored event projections omit reasoning and tool arguments/results.

Initial observation imports the recent bootstrap page as historical and establishes
a live tail, not a complete archive import. An explicit bounded recovery reads
historical pages and records the remaining-history/gap warning. Historical outputs can be classified, but cannot
be pushed as newly received replies. Cursor expiry is visible and requires
explicit resynchronization; taking a new tail never proves that nothing was
missed.
An exact completion event observed live before that initial page finishes remains
new; other bootstrap content stays historical. Changing an ordinary session into
an internal role invalidates its active reader and pending ordinary work/effects.
Neither old source records nor immutable reply anchors are rewritten.

Only a durable primary `assistant.message` with an explicit empty
`toolRequests`, a known parent `assistant.turn_start`, and a primary
`assistant.turn_end` directly referring to that message qualifies for reply
work. This evidence pattern follows the public native event relationships. A
provider or history window that does not prove it remains unclassified native
data, not a fabricated final reply. Child attribution on either the event or
its data excludes it. Arbitrary assistant text, tool commentary, and `idle`
never establish completion.

This proves a complete text response, not the success of any work described in
that text. Delivery-to-response correlation remains `unknown`; session identity
does not prove which of several user inputs a response answers.

## Contextual routing, questions, and historical compatibility

New inputs contain only `requestId`, `text`, optional native `attachments`, and
an optional `topicId` context hint. `POST /messages` strictly rejects `replyTo`,
including null, rather than silently changing old delivery semantics. No new
output creates a generic anchor. The coordinator selects a topic, reception, or
current native question using original messages, source sessions, recent topics,
routes, and publications. Publications expose prior recipient clarifications
with their original input and topic, so the next ordinary answer can continue
that exchange. Only a genuinely uncertain recipient warrants one brief target
clarification; this is not another business authorization or demand for a
literal option. Semantic interpretation is not guaranteed native causality.

Native answers select a stored `answerQuestionId` and its single session; the
backend retains the real request ID. Exact option text is a choice; other text
is forwarded unchanged as freeform when allowed, including reservations,
comments, and follow-up questions. Choice-only questions and attachments have
explicit route errors, without stripping content or bypassing them via prompts.
Input can be durably accepted before its eventual route is known. A pending
question blocks ordinary prompts only to its own session, not other topics or
sessions. A matching option alone does not block creation for an unrelated goal.

Dispatch rechecks the original request. An ask rejected before the native call
(including a stale/replaced question or unavailable target) leaves the rejected
delivery as evidence and returns the same input work to pending with the observed
question facts and their availability. A definitive native rejection
also permits deliberate re-evaluation. Fresh lease/version checks and a new
decision receipt are required; no automatic retarget or resend occurs. User
publication is not duplicated by that recovery. Pending, calling and unknown
deliveries prevent rerouting the same message; accepted destinations are skipped
in an authorized partial-failure recovery. Unknown native effects never reopen
work automatically. Ask text receives no risk warning or context suffix.

There is no destructive migration. Historical `Message.replyTo`,
`Publication.anchorId`, and anchors remain intact. New records retain null
fields for storage compatibility. Previously accepted anchored input keeps its
original destination, and old accepted/unknown operations retain their original
fingerprints and receipts. Only `GET /inputs/:requestId` accepts the historical input
shape for receipt readback (`ReceiptInput`, optional original `replyTo`);
`NativeInput` has no `replyTo`. A browser with an old pending transaction must
preserve its complete payload and request ID, compare the complete normalized
receipt, and use GET-only recovery. It must never strip the field or POST the
old request again, even if no receipt is found. No anchors are required for new
messages, and this compatibility is not a second routing API.

Reception records now index observed ordinary sessions; they are not a separate
role or a prerequisite the user must configure. A topic may route to several
ordinary sessions and a session may serve several topics. Topic labels do not isolate a shared native model
context. Risk detection uses active independent topics and actual reception
relationships. Its exact warning is both published and appended to the normal
user prompt as separately attributed context; no extra native turn is created.
Durable context-exposure records include historical deliveries and survive routing
changes; a handoff never means the previous reception forgot an active topic.
Rate limiting and an explicit continue-sharing acknowledgment suppress repeats.
The notice alone is not permission to create or split sessions; creating a target
still needs the coordinator's validated current input work and explicit directory.

## Memory and revisions

User topic changes schedule incremental extraction for the departed topic;
background outputs only mark their assigned topic dirty. Changing reception
within one topic is not a topic switch; a handoff summary can be separate work.
Each memory item records confirmed, reported, or inferred content and exact
source message/content/classification versions. Work freezes a bounded source
set and watermark, and the whole batch commits or rejects together. Newer
messages remain dirty.

Correction and reclassification invalidate affected derived memory. Original
body versions and prior publications remain available; a correction does not
re-send an already accepted user instruction. Native question text cannot be
edited through the correction API. Classification is interpretation, while
original native session/event IDs and reply anchors remain provenance.

## Publication and reconnect

Publication records contain full display text, references, topic, and an optional
historical anchor. New publications have no anchor. Raw source text is stored separately. Accepted user input remains
pending source/work data until a coordinator decision publishes it. The durable
event API supports bounded replay; SSE frames contain whole publication JSON values,
not token deltas. Reconnect after the last fully consumed event ID; duplicates
can be discarded by that sequence. The stream applies backpressure and stops
on request abort. Browser receipt is not an acknowledgment that the user read
the message.

The conversation is a read-only projection over that log, not a second source
of truth. It renders only user speech, assistant answers and necessary questions.
Hidden diagnostic publications still advance history and reconnect cursors.
Current source revisions update already-published conversation bodies and
attachments in place without rewriting the original publication or generating
a new-message notification. Reclassification alone preserves published wording;
destination clarifications are separate speech, not replacements for their
source input. The same visible projection supplies the bounded Speech reference.

Background publication never changes the foreground topic. Internal wake
receipts, risk notices, and system status do not become new semantic input, so
they cannot create a reminder loop.

See [API and role setup](api.md) for exact routes, payloads, resource readiness,
and live persistent configuration.

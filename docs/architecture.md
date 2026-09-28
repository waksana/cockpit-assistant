# Architecture and reliability

## Ownership and trust

One activation manages one Assistant space under its module-private `dataRoot`.
Cockpit authenticates the enclosing digest-bound HTTP routes. Native conversation
reads are limited to explicitly enrolled receptions/collaborators, and user
deliveries to direct receptions; internal role carriers and their control/readiness
checks are registered separately. There is no all-session catalog scan,
private SDK handle, native-home scan, Task dependency, or shell-based native
adapter. IDs locate records within this space, not arbitrary host data.

The module runs trusted code in the host process. Role instructions and MCP
checks are not an OS sandbox and do not remove Copilot's native permissions.
The host-observed `cockpit/invocation` metadata supplies main-session identity;
tool arguments cannot select it. Missing metadata, internal-agent calls,
retired epochs, unready bindings, and obsolete leases are rejected. The
installation trusts the host and its authenticated same-user operator, not
arbitrary HTTP clients claiming to be the host.

No automatic session creation or replacement is enabled. Each creation is an
explicit API operation, produces a durable receipt, and does not enroll the
result as a receptionist. Creation uncertainty blocks further creation until
explicitly resolved. Binding checks the expected model, directory, actual role
assembly, resource preparation, and readiness. Replacement is a compare-and-swap
epoch change; late work cannot commit through the retired carrier.

## Durable processing

```text
user input -> inbox -> coordinator work -> atomic decision + outbox
                                                       |
                                                 native effect
                                                       |
enrolled cursor history -> evidenced output -> coordinator -> publication log
                                          topic switch -> memory work
```

SQLite uses WAL and `synchronous=FULL`. A Linux abstract-socket lease prevents a
second cooperating activation from recovering or dispatching the same store.
The database commit precedes an acceptance response. Message bodies, source
identities, classification versions, anchors, role epochs, leases, operation
fingerprints, and effect/publication state are durable. Sequence cursors are
database order, never UUID lexical order.

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

Initial enrollment imports the recent bootstrap page as historical and establishes
a live tail, not a complete archive import. An explicit bounded recovery reads
historical pages and records the remaining-history/gap warning. Historical outputs can be classified, but cannot
be pushed as newly received replies. Cursor expiry is visible and requires
explicit resynchronization; taking a new tail never proves that nothing was
missed.

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

## Anchors, questions, and reception

An explicit reply anchor freezes its original reception and optional native
request ID. Topic reclassification and handoff never rewrite it. An ordinary
comment carries its source reference through a normal queued prompt. A native
question goes through the native answer API, retaining its exact request ID,
literal choices, and free-text restrictions. The program rechecks current
native questions immediately before answering. Races can still reject an
answer; they never redirect it to a replacement question.

An unanchored answer can map automatically only to one unique literal pending
choice. Other ambiguous answers need clarification. Several pending questions
coexist; a missing/unloaded/deleted original session is visible, not replaced
silently. Ask answer text never receives a risk warning or context suffix.

Reception enrollment distinguishes direct reception from background
collaborators. A topic may route to several enabled receptions and a reception
may serve several topics. Topic labels do not isolate a shared native model
context. Risk detection uses active independent topics and actual reception
relationships. Its exact warning is both published and appended to the normal
user prompt as separately attributed context; no extra native turn is created.
Durable context-exposure records include anchored deliveries and survive routing
changes; a handoff never means the previous reception forgot an active topic.
Rate limiting and an explicit continue-sharing acknowledgment suppress repeats.
The notice is not permission to create or split sessions.

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

Publication records contain full display text, references, topic, and optional
stable anchor. Raw source text is stored separately. Accepted user input remains
pending source/work data until a coordinator decision publishes it. The durable
event API supports bounded replay; SSE frames contain whole publication JSON values,
not token deltas. Reconnect after the last fully consumed event ID; duplicates
can be discarded by that sequence. The stream applies backpressure and stops
on request abort. Browser receipt is not an acknowledgment that the user read
the message.

Background publication never changes the foreground topic. Internal wake
receipts, risk notices, and system status do not become new semantic input, so
they cannot create a reminder loop.

See [API and role setup](api.md) for exact routes, payloads, resource readiness,
and live persistent configuration.

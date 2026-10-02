# Small native service

```text
User <-> native Assistant Chat -> Assistant MCP -> service -> topic session
               ^                                 |
               |          read and consume inbox |
               +---- lightweight result reminder-+ <- worker reply
```

The native session owns the complete conversation, attachments and natural
clarification. Assistant has no message mirror or per-message classification
protocol. The service owns only four active tables:

| Table | Responsibility |
| --- | --- |
| `topics` | Flat definitions, current native session mapping and actual creation outcome. |
| `deliveries` | Source/native IDs, target, split fingerprint and delivery outcome; no prompt/body copy. |
| `mailbox` | Unread replies/questions and attachment references, deleted when returned by an inbox read. |
| `seen` | Small native identity, input-origin, read-call receipts and latest foreground load outcome; no transcript bodies. |

One genuine native user input has one frozen topic split. Existing workers retain
their IDs; unloaded workers load and ordinary business prompts use `immediate`.
For a busy source this is native steering into its in-flight run, not an abort,
queue clear, independent parallel turn or a promise of immediate model attention.
Several inputs may share a reply. Existing queued inputs are not rewritten.
Unknown native outcomes
are retained, not resent or replaced. An accepted send or idle worker does not
mean the business is complete.

New topic sessions have no dedicated Assistant role or injected reporting
protocol. The existing optional configuration is interpreted as documented in
[session setup](api.md#session-setup); default creation delegates resource
selection to the Host. A partial native creation retains its original identity
and phase in the public topic receipt, without binding or sending prematurely.

## Native input, not a second chat

Host `promptAccepted` observations identify actual native receipts and ingress
class. Assistant stores that small fact and joins the current native tool call
to its interaction and original native user message. No text is copied into an
input store. A module notice, generic API prompt or unknown source is not human
authorization. Missing or conflicting evidence fails explicitly.

The `user` class is the Host's admitted same-origin browser boundary, not
physical-human attestation or an OS sandbox. A local process capable of forging
HTTP headers is already inside that Host trust boundary. Original native source
and subagent identity are still checked. Direct generic MCP prompts do not gain
human status merely because native history names the event `user.message`.

The foreground has only the role's MCP tool subset and Skill. The native Host
enforces resource discovery/connection policy and tool filtering; the module
checks actual readiness and offered raw identities before using a caller.

## Inbox and notices

Only registered topic workers are observed. Unrelated developers, observers and
internal Assistant/organizer sessions are excluded. Complete main-agent reply
text, including text accompanying a tool call, is eligible; transient chunks,
tool results and subagent output are not separate replies. Eligibility for storage
does not trigger immediate presentation: ordinary notices wait for the source to
be loaded, idle, with known inactive processing/work and empty pending/steering
queues. A settled native error can also notify, explicitly as an error. Unknown
activity or an unloaded source does not establish idle. Abort/error events retain
their native identities and warn that earlier output may be incomplete.
Live callbacks are drained per source; new output waits for its root native
`session.idle` event before sampled idle can release it. Pending bodies recovered
at service startup can use current idle metadata. A missed live idle observation
does not become an invented completion; explicit inbox/history reads remain
available. Source observations invalidate metadata sampled across asynchronous
lookups, preventing stale question consumption or a reminder after work resumes.
These are sampled native facts, not an atomic lock against a future user action.

This intentionally waits across queued A/B requests and immediate steering.
`assistant.turn_end` is an agent-loop boundary, not a reliable per-request
completion contract. An isolated Host 29 / SDK 1.0.13 probe emitted multiple such
events and no idle between queued A and B; its declared experimental
`session.completion_receipt` did not fire. No delay or fabricated completion
receipt substitutes for that missing guarantee.

An inbox read transaction removes only entries included in its response. Unread
pages and later arrivals remain. A repeated native read-call ID never consumes a
second page. Reading does not delete native histories or files. If a response is
lost or the model stops after reading, use native history; there is deliberately
no presentation-hash, ACK or replay state machine.
An explicit read can include accumulated partial progress before source idle.
Before reads and reminders, native asks are compared with current loaded session
state, including request ID, text and choices. Stale asks are removed from the
unread mailbox, retaining their deduplication identity. Unavailable/unloaded asks
remain unread but are not presented as current; no session is loaded to inspect
them. A valid question may notify while its source is busy, avoiding a deadlock.

Eligibility is checked before foreground discovery. Only eligible pending mail
can load the already-selected original foreground. Concurrent callbacks share
one notification drain and load attempt. The load intent is recorded before the
Host call, then its acknowledgement and original identity are read back. Missing
identities are not replaced, loaded handles are not reloaded, and no polling or
permanent keepalive is introduced. A failed/unknown attempt is not repeated
after a later event or restart; a normal public Host load of the original session
allows readback recovery. See [API recovery](api.md#one-mcp-endpoint).

Before sending, the service checks exclusive applied roles, exact offered
tool identities and native resource readiness, then samples source eligibility
and foreground identity/roles/activity again. Source events invalidate stale
samples across these awaits; foreground events also invalidate earlier resource
readiness, even when the saved roles are unchanged. If the last eligible ask expires or a reply is
consumed while loading, no reminder is reserved. Starting a load does not consume
mail or count as notification.

When the foreground is idle, the service sends a bounded location-only reminder
for eligible entries using `enqueue`, never business dispatch's `immediate`.
The current SDK has no public system-notification sender, so the reminder is a
visible ordinary native message. It is not a user business request. The service
does not re-notify an uncertain send or inject all worker bodies into context.

The service opts into Host `shutdown.v1`. The early `stopping` signal stops new
producers; `onStop` joins already-started operations and records accepted or
unknown results while storage remains open. Only final `dispose` closes the
store and releases its lease. No new foreground load or prompt starts during
drain, and interrupted load receipts recover as unknown rather than replaying.

## Semantic responsibility

The foreground independently maintains only the register and actual status.
Designing Assistant or the topic system is business and goes to a worker too.
It may summarize reports while preserving uncertainty and disagreement, but may
not evaluate quality, invent conclusions, add business follow-ups or answer for
the user.
The Skill uses the foreground's existing conversation to present only semantic
novelty and actual state changes, in topic-oriented language. This is model
guidance, not guaranteed semantic deduplication or a second presentation ledger.
It must not suppress new user inputs, requested repetition, corrections or failures.

Native asks require a separate single-topic dispatch matching the complete human
original. Only outer whitespace is trimmed. Constrained choices match the whole
answer; model paraphrases or a word extracted from a negation are refused.
Question identity is rechecked before delivery. Rare stuck questions can be
handled in the original native Chat.

Old persisted rows are an inert archive, not active model entities. Offline
upgrades and preservation are documented in [releases](releases.md).

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
| `seen` | Small native identity, input-origin and read-call receipts; no transcript bodies. |

One genuine native user input has one frozen topic split. Existing workers retain
their IDs; unloaded workers load and busy workers enqueue. Unknown native outcomes
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
tool results and subagent output are not separate replies.

An inbox read transaction removes only entries included in its response. Unread
pages and later arrivals remain. A repeated native read-call ID never consumes a
second page. Reading does not delete native histories or files. If a response is
lost or the model stops after reading, use native history; there is deliberately
no presentation-hash, ACK or replay state machine.

When the foreground is idle, the service sends a bounded location-only reminder.
The current SDK has no public system-notification sender, so the reminder is a
visible ordinary native message. It is not a user business request. The service
does not re-notify an uncertain send or inject all worker bodies into context.

## Semantic responsibility

The foreground independently maintains only the register and actual status.
Designing Assistant or the topic system is business and goes to a worker too.
It may summarize reports while preserving uncertainty and disagreement, but may
not evaluate quality, invent conclusions, add business follow-ups or answer for
the user.

Native asks require a separate single-topic dispatch matching the complete human
original. Only outer whitespace is trimmed. Constrained choices match the whole
answer; model paraphrases or a word extracted from a negation are refused.
Question identity is rechecked before delivery. Rare stuck questions can be
handled in the original native Chat.

Old persisted rows are an inert archive, not active model entities. Offline
upgrades and preservation are documented in [releases](releases.md).

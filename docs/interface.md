# Assistant interface

## Entry and setup

On a compatible host, choose **助手** in the global hamburger menu. This opens a
near-viewport native dialog (full-screen layout on mobile), not browser
Fullscreen mode. A public global component stays in the host React tree outside
session routes; the menu only changes the module-owned visibility service.
The frontend declares no native draft or send capability.

Each opening checks the bound coordinator and memory sessions. Opening never
creates, loads, repairs, replaces, or enrolls sessions. Their status distinguishes
checking, unbound, unloaded, invalid, unknown and ready. History and draft editing
remain available while sending is disabled.

Use the setup controls to explicitly create a carrier with its working directory,
or inspect a known session ID. Creation and binding are separate actions. Binding
uses the inspected actual model and current role epoch, not a guessed default.
The two roles must use distinct eligible carriers with their applied Assistant
role; labels alone do not establish readiness. Native session loading, model
changes and applying changed roles remain explicit Cockpit operations.

An ordinary reception also needs explicit enrollment. Internal role carriers are
not reception targets. The UI does not browse or enroll the host session catalog.
Every create/bind/enroll action retains its request ID and receipt; an uncertain
operation does not silently retry under a fresh ID.

## Conversation

Messages follow durable publication sequence, displaying the source speaker,
session and recorded timestamp. Consecutive publications with the same topic
form one titled block. A, B, A are three blocks, with the same stable topic
accent for both A blocks. Titles, not color alone, identify topics. System
publications without topics remain unassigned.

Markdown is rendered as React elements with raw HTML kept as text. Script/data
links are not navigation; images are represented as explicit links instead of
unsolicited remote fetches. Fenced code, tables, lists and long text remain
readable in both themes.

Use a message's reply action to select its immutable anchor; cancel the reference
to return to an unanchored input. Native question choices and free-text limits
remain visible. The backend rechecks the original question before answering.
Topic changes never retarget an anchor. Enter submits, Shift+Enter inserts a
line break, and composition/IME Enter is not a submit.

The input is sent through Assistant's `/messages`, not a host native draft.
The backend freshly verifies both role bindings before accepting new input.
Saved input waits for coordinator classification and durable dispatch. Accepted
is neither proof of delivery nor proof the receiver completed its work. Receipt
controls inspect current work/delivery state. Failures preserve input and IDs;
unknown sends block another send until the original receipt is reconciled.

## History and lifecycle

Opening loads the latest 50 publications, then connects enriched full-message SSE
from the loaded watermark. Earlier history is explicit bounded upward paging.
Duplicate stream records are ignored; an out-of-order record is not applied past
the last known sequence. Reconnection reads ordered missing pages before resuming
the stream. This never uses host chat history or reloads every table per message.

There is one main reading scroller. It initially positions at the latest content,
preserves position when older items are prepended, and follows new messages only
while the reader stays at the bottom. Otherwise a new-message action lets the
reader choose to return. Refresh does not move keyboard focus.

Closing aborts reads and the stream, not accepted writes. Late write results
belong to their original request and clear only the exact captured draft revision,
never text edited afterward. Reopening rereads readiness and the recent window;
the draft, selected anchor and receipts survive closing within this module
activation. They are not persisted across a full page reload or module revocation;
the durable backend remains authoritative and exposes receipts through the API.
Record uncertain IDs before a full browser reload. Errors remain in their owning
UI; a write that settles after module disposal reports its failure to the host.

## Backend additions

These module-relative routes supplement, not replace, existing `/history`,
`/events`, `/events/stream` and table pagination. See [API conventions](api.md).

| Route | Result |
| --- | --- |
| `GET /timeline?limit=50` | Latest bounded window, ascending by publication sequence. |
| `GET /timeline?before=N&limit=50` | Exclusive older window; `{items,before,hasMore,watermark}`. |
| `GET /timeline?after=N&limit=100` | Exclusive forward recovery; also returns `cursor`. |
| `GET /timeline/items/:sequence` | One enriched current projection of a durable publication. |
| `GET /timeline/stream?after=N` | SSE `publication` frames with enriched items; `Last-Event-ID` wins. |
| `GET /readiness` | Fresh passive roles and explicitly enrolled receptions; no creation or wake. |
| `GET /sessions/:id/inspect` | Explicit session model, directory, loaded state and reload flag; no catalog. |
| `GET /operations/:id` | Exact durable operation receipt, or 404. |
| `GET /inputs/:requestId` | Original accepted input, bounded related work/deliveries and per-list `hasMore`. |

`before` and `after` cannot be combined. Limits are 1 through 100. `watermark`
is the global highest publication sequence at that read, not proof the user read
it. `TimelineItem` extends `Publication` with `topicTitle`, `speaker`, `sessionId`
and nullable `question` (`state`, optional `choices` and `allowFreeform`). Topic
titles and question state are current enrichment, not edits to immutable
publication text or anchors. Exact lookup and a fresh page can observe later
question state; SSE is a publication log, not a general mutable-record change feed.

`Readiness` contains role session IDs, expected epochs/models/directories,
statuses and explanations, plus `canSend` and up to 100 enabled direct receptions.
Disabled historical entries and collaborators remain available through the
existing paginated `/receptions` API, but do not crowd active receivers out of
the readiness window. The interface additionally
requires an enabled loaded reception before submitting. Readiness is an observation,
not a lease over future native state; races can still fail explicitly at dispatch.

## Delivery boundaries

Source merge does not install or deploy this module. Browser coverage uses
synthetic data and a pinned host UI fixture, not production sessions. Chrome
mobile emulation is not a real-device iOS keyboard/zoom or universal accessibility
certification. The backend still does not promise cross-system exactly-once
delivery or proven model completion.

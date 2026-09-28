# Assistant interface

## Entry and setup

On a compatible host, choose **助手** in the global hamburger menu. This opens a
near-viewport native dialog (full-screen layout on mobile), not browser
Fullscreen mode. A public global component stays in the host React tree outside
session routes; the menu only changes the module-owned visibility service.
The frontend declares no native draft or send capability. The left arrow closes
the native dialog and returns to the existing Cockpit view; it never navigates
browser history or changes the selected host session. The single gear on the
right toggles settings. Both actions use exact Lucide 1.46.0 nodes through host
React, public `ck-icon-button` targets and `ck-icon ck-icon-lg` sizing, with
accessible names and tooltips. The package includes the upstream Lucide license.

Each opening freshly checks the registered **coordinator** and **memory**
sessions. Display names are exactly these role identifiers. Status distinguishes
checking, unbound, unloaded, invalid, unknown and ready. History and draft editing
remain available while sending is disabled.

Choose coordinator or memory when creating a session or adding roles in Cockpit.
The host's saved-role callback registers the carrier even when the role is not
ready yet. Registration does not prove application or readiness. Settings explain
this workflow and show status and receipts, not manual session-ID, creation,
binding, reception-enrollment or default-scope forms. Existing explicit backend
binding APIs remain available for recovery.

When the fresh opening snapshot identifies an already-bound unloaded carrier,
the frontend makes a separate `/roles/activate` mutation with a stable request ID
and the captured role/session/epoch binding vector. The backend verifies that
vector before loading only those already-bound unloaded internal carriers.
Opening never creates or replaces carriers, scans directories for bindings,
reloads loaded sessions, changes models or forces pending roles to apply on an
already-loaded carrier. Refresh is read-only. Cold-loading an unloaded carrier
includes the host's ordinary native tool initialization and validation, but
Assistant adds no extra resource repair, forced reload or automatic enablement
of disabled resources. Users handle pending roles on loaded sessions or disabled
resources in Cockpit, then refresh. A loaded registered carrier can still remain
not ready.
Unknown load state is not treated as unloaded or ready. Ordinary sessions are
observed automatically; no reception enrollment is required.

Activation retains the exact `activate:<requestId>` receipt through close/reopen.
Pending and unknown operations block a fresh automatic activation request.
Receipt inspection uses `GET /operations/:id`, not another mutation. A completed
receipt is not readiness: the UI refreshes the passive readiness endpoint.
Refresh itself never activates. An attempted binding vector is not automatically
retried until its originally unloaded roles have subsequently been observed ready.

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
| `GET /readiness` | Fresh passive role status; no creation, load, reload or registration. |
| `POST /roles/activate` | Stable request ID and captured `bindings: [{role,sessionId,epoch}]`; exact durable activation operation. |
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
statuses and explanations, plus `canSend`. The compatibility `receptions` field
is not a setup list or an additional frontend send requirement.
Readiness is an observation,
not a lease over future native state; races can still fail explicitly at dispatch.

## Delivery boundaries

Source merge does not install or deploy this module. Browser coverage uses
synthetic data and a pinned host UI fixture, not production sessions. Chrome
mobile emulation is not a real-device iOS keyboard/zoom or universal accessibility
certification. The backend still does not promise cross-system exactly-once
delivery or proven model completion.

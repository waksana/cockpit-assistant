# Assistant interface

## Entry and setup

On a compatible host, choose **助手** in the global hamburger menu. This opens a
namespaced module page in Cockpit's existing SPA and React tree. The URL supports
direct entry, refresh, and browser forward/back navigation. It is not a dialog,
portal overlay, separate site, or second React root.
The frontend uses a public owner draft, not a native-session draft or prompt
sender. Its Composer, Message and Attachment components come from the same
`context.components` entry as the host. The left arrow navigates explicitly to
Cockpit's home/session list; it never blindly goes back to an external history
entry. Header controls use exact Lucide 1.46.0 nodes through host React, public
`ck-icon-button` targets and `ck-icon ck-icon-lg` sizing. The package includes the
upstream Lucide license.

Each opening freshly checks the registered **coordinator** and **memory**
sessions. Display names are exactly these role identifiers. Status distinguishes
checking, unbound, unloaded, invalid, unknown and ready. Each role has a separate
icon control with an accessible name and tooltip; keyboard or touch activation
opens compact status details and passive refresh. The independent connection icon
reports only SSE state, never role readiness. Normal status sentences do not
occupy the reading area. History and draft editing remain available while
sending is disabled.

Choose coordinator or memory when creating a session or adding roles in Cockpit.
The host's saved-role callback registers the carrier even when the role is not
ready yet. Registration does not prove application or readiness. There is no
settings panel or manual session-ID, creation, binding, reception-enrollment or
default-scope form. Unbound status details explain the normal role workflow.
Existing explicit backend binding APIs remain available for recovery.

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

Activation retains the exact `activate:<requestId>` receipt through page navigation.
Pending and unknown operations block a fresh automatic activation request.
Role status details expose receipt inspection through `GET /operations/:id`, not
another mutation. A completed
receipt is not readiness: the UI refreshes the passive readiness endpoint.
Refresh itself never activates. An attempted binding vector is not automatically
retried until its originally unloaded roles have subsequently been observed ready.

## Conversation

An empty timeline is blank. There is no duplicate conversation heading, empty
state paragraph, static message label, or permanent composer help text. Necessary
loading indicators, actionable errors, questions, and their original options remain.

The reading area is ordinary conversation, using the host's shared message
presentation for user bubbles, assistant bodies, Markdown, timestamps and
attachments. Topic and source-session metadata remain available to the backend,
not displayed as titled blocks, colored borders or UUID labels.

Only user speech, user-facing assistant answers and necessary questions appear
in the main flow. Internal role output, wake receipts, lifecycle status, risk and
correction notices are not chat bubbles. Their durable records are not deleted.
Corrections update the affected visible body and attachments in place; a later
publication of the same source replaces its presentation without duplicating
the message. Destination clarifications remain independent assistant questions.

Markdown uses Chat's shared host renderer rather than an Assistant-specific
parser or stylesheet. Fenced code, tables, lists and long text use the same
semantics and presentation in both themes.

Every new input is an ordinary message, without quote selection or `replyTo`.
The coordinator uses recent conversation, topics, source sessions and actual
pending questions to choose a recipient. It asks a short destination clarification
only when the target is genuinely ambiguous, not to renegotiate the user's
business decision. A topic change does not force a reply to an unrelated question.

Native questions retain their recorded options and free-text limits. Choosing an
option fills its exact text into the same Composer; it does not bind the next
message to a hidden anchor or send it automatically. Other comments and follow-up
questions can be entered normally. When routing to a native ask, the backend
checks its real session/request identity and pending state, preserves the user's
wording and respects native freeform/attachment restrictions. Accepting new input
does not establish that a selected native route supports it.

The shared Composer owns keyboard/IME behavior: desktop Enter submits,
Shift+Enter inserts a line break; touch input keeps Enter for typing and supports
the explicit send button. The editor remains the public Composer even when a
displayed question accepts only listed options.

The input is sent through Assistant's `/messages`, never the background native
Chat. Public File/Speech enhancements attach to this same host-issued draft;
Assistant does not import their stores, implement upload/recording UI, or
fabricate a session ID. Text and attachment-only submissions follow the same
adapter for buttons and captured Speech sends. New messages can carry attachments
before their destination is known. A native ask cannot receive attachments; the
backend rejects that route without dropping attachments or silently sending a
normal prompt instead.
The backend freshly verifies both role bindings before accepting new input.
Saved input waits for coordinator classification and durable dispatch. Accepted
is neither proof of delivery nor proof the receiver completed its work. Receipt
controls inspect current work/delivery state. Failures preserve input and IDs;
unknown sends block another send until the original receipt is reconciled.
The header receipt control exposes complete receipts and explicit inspection;
unconfirmed failures also provide a visible recovery action.

## History and lifecycle

Opening loads the latest 50 publications, then connects enriched full-message SSE
from the loaded watermark. Earlier history is explicit bounded upward paging.
When a history page contains only hidden diagnostic records, the same read
continues through bounded older pages until conversation is found or history
ends. An entirely diagnostic history leaves the conversation area blank.
Duplicate stream records are ignored; an out-of-order record is not applied past
the last known sequence. Reconnection reads ordered missing pages before resuming
the stream. Hidden publications still advance the raw sequence cursor, including
system-only catch-up pages. This never uses host chat history or reloads every
table per message.

There is one main reading scroller. It initially positions at the latest content,
preserves position when older items are prepended, and follows new messages only
while the reader stays at the bottom. Otherwise a new-message action lets the
reader choose to return. Only newly visible conversation increments that count,
not system records, corrections or repeated publications of an existing message.
Refresh does not move keyboard focus.

Leaving the page aborts reads and the stream, not accepted writes, and does not retire
the owner. It invalidates captured sends by advancing the business action
revision. The page's editor and enhancements unmount instead of hiding behind an
overlay; a background Chat editor cannot receive its keyboard or captured sends.
Late results clear only captured text/field versions; new text and attachments
survive.

The host persists the request ID, submission ID, complete immutable payload,
schema checkpoints and settlement journal before network dispatch. Assistant's
non-projecting business schema retains lifecycle revision and receipt indices,
not another text/revision store or a reply target. Old business drafts restore
their text, attachments, lifecycle revision and receipts but discard the obsolete
selected-reply UI state. Historical records and original accepted/unknown input
identities are not rewritten. Reload restores the original transaction as uncertain.
**Recover original submission** queries `/inputs/:requestId`, proves the complete
original input, then settles the original transaction without another POST.
Missing/mismatched receipts stay unknown. A failed field ACK is an incomplete
local cleanup, not permission to resend accepted input. Missing field schemas
block lossy text-only submission. Module revocation removes runtime authority;
the host's occurrence/generation rules govern subsequent restoration. File ACK
does not delete the persisted uploaded file needed by future delivery.

Speech reference text comes only from an already-rendered eligible Assistant
reply, bounded to the final 1,000 Unicode code points. No background Chat or
implicit history read supplies that context.

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
it. `TimelineItem` extends `Publication` with `topicTitle`, `speaker`, `sessionId`,
native `attachments`, a current source `revision` when available, and nullable
`question` (`state`, `stateVersion`, optional `choices` and `allowFreeform`).
Question snapshots merge by their durable state version rather than publication
order, so newly read older pages cannot be overridden by a cached stale status.
Public message presentation uses an Assistant-owned identity;
it never uses a publication ID as a native message ID. Topic
titles, source revisions and question state are current enrichment, not edits
to immutable publication text or anchors. Exact lookup and a fresh page can observe later
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

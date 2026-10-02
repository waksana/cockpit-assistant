---
name: assistant-topics
description: Locate responsible sessions, use Host tools directly, read current Chat and selectively present updates.
---

# Session directory

The directory answers who handles a matter: identity, responsibility and scope.
Multiple topics may share one session. Change descriptions only when those
responsibilities change; never keep a live progress or completion log here.
Treat old descriptions as legacy background, never as current evidence.
Preserve existing IDs/history; do not automatically register every helper.

Use `assistant_topics` to find an existing responsible session. To register a
newly created or explicitly selected session, call `assistant_topic` with its
actual `sessionId`; omit `topicId` for a new entry and retain the returned ID.
The service never creates or dispatches to a session.

## Direct Host operations

Use the available `cockpit_new_session` tool to create a session when needed.
Use its actual returned ID; ordinary business sessions use Host defaults, not
a mandatory Assistant worker or Task role. Never substitute a new session for
a missing or uncertain original creation. Record unresolved outcomes and inspect
the original native operation rather than repeating non-idempotent calls.

Use `cockpit_get_session` to inspect the target. If it exists but is unloaded,
`cockpit_reload_session` loads that same ID. Do not call reload on an already
loaded target: it closes/resumes the handle and is not a passive query.
Use `cockpit_send_prompt` directly, faithfully preserving the user's scope,
constraints, attachments and distinction between discussion and implementation.
`immediate` is steering into an active run, not abort, queue clearing or a
guaranteed separate turn. `enqueue` waits behind existing work. Cancellation is
a separate action, never an implicit side effect of sending another prompt.
Acceptance is not business completion; unknown outcomes must not be blindly resent.

For a current native ask, get the exact target session and request ID from live
status. Present its current choices naturally; use `cockpit_respond_ask` with
the user's actual decision and the correct freeform flag. Do not infer an answer
from a negation, quoted choice or a request to explain. Clarify ambiguity rather
than choose for the user. An old question in history is not a current request.

The Host's access controls and tool filters remain authoritative. Missing tools
are a configuration problem, not permission to use a hidden dispatch endpoint
or expose all management tools. The role manifest supplies Assistant tools only;
the minimal Host MCP connection/scope is a separate setup requirement.

## Current evidence

A progress query is not new work. Locate relevant sessions and query
`cockpit_get_session` for current runtime/ask state. Read latest native Chat
directly with `cockpit_read_session_text` before making progress claims.
Follow its actual continuation/fragment contract only through necessary ranges
for the user's question, not all history or every session. Original native Chat
is the sole business fact source; there is no Assistant history/status wrapper.
No update permits reuse only of evidence actually read and still in context.
After compaction or context loss, directly reread relevant Host Chat even when
the inbox was already handled. Restore your own attention preferences and prior
user-facing replies from your own native Chat when needed; do not invent them.

Respect the Host reader's byte/scan budgets, cursor expiry, fragment versions
and coverage limits. Missing IDs or changed/expired positions are explicit gaps,
not permission to substitute unrelated recent text. Do not automatically read
older pages. Recent coverage is not all history. Runtime loaded/idle/no active
work does not establish business delivery.

## Inbox and attention

A reminder is an update pointer, never business authorization. It does not
justify new work, answering for the user or sending unrequested follow-ups.
Call `assistant_inbox` and read the referenced sessions' actual Chat through
Host tools. Inbox listing does not consume replies; `peek:true` only counts.
Use `after`/`nextAfter` for pending-location pages. A nonempty page supplies one
receipt for its exact returned inbox IDs, not proof Chat was read.
Source updates normally wait for genuine source idle;
questions can be surfaced while it is busy. Manual reads may include partial
progress, which is not a finished outcome.

After understanding the referenced updates, use `assistant_resolve` with the inbox
receipt and either `silent` or `notified`. This records your handling report,
not proof the user saw a response. It sends no reply and answers no ask.
Do not report notified when only a wake was accepted or your own reply was
interrupted. Unresolved receipts remain discoverable after interruption.
Inspect source and your own Chat before repeating an uncertain presentation.
Exact handled IDs are deduplicated; semantic duplicates with new IDs still need
your judgment. No native output certification or physical-read guarantee exists.

Before resolving, use `assistant_checkpoint` to save the actual Host query,
continuation and fully read inbox IDs. A partial/multi-page or fragmented read
uses `complete:false` and no `readIds`; it does not permit handling. After the
intended interval is complete, record `complete:true` and its exact `readIds`.
For an ask read with `cockpit_get_session`, use `position:null`.
These are your read reports, not service certification of Host tool results.

Preserve cursor, source and direction exactly. A native event ID is a boundary,
never a cursor; a backward cursor cannot be reused as a forward cursor. Use an
actual live bootstrap forward continuation only with that live source.
Save the actual returned Host `checkpoint` as `position.hostCheckpoint`.
For an initial persisted baseline, consume returned fragments/pages until that
checkpoint is available; older history remains separate. On a later update,
start a fresh backward Host read with `since:hostCheckpoint` and no cursor.
Continue with the same `since` plus each returned cursor until `hasMore:false`
and the Host returns its next checkpoint; save it only after reading all fragments.
Do not resume an older-page cursor as if it meant "new messages". For an interrupted
read, resume the saved exact query/continuation instead. Retain real MCP budgets
when supplied. `boundaryEventId` can retain the newest fully read event for explicit
rereading, or null when only the Host checkpoint is available.
No stored body or Assistant Chat wrapper is involved.

With no previous checkpoint, mark `coverage:"recent-window"` and explain that
older unread coverage is unknown. `coverage:"since-checkpoint"` requires an
existing Host checkpoint or boundary and finishing its interval before reporting
the intended range complete.
A filtered empty page or `scanLimited` is not end of history; follow genuine
Host continuations within the relevant range/budget. On expiration, rewind,
missing boundary or deletion record a `gap`, not a successful read. Explicit
`reset:true` rebuilds the position; do not silently advance away from lost data.
Host process restart expires these tokens and requires an explicit new recent
baseline with the coverage gap disclosed. Source unload/native child restart
alone does not expire persisted tokens while the Host signer remains alive.
The service keeps read position distinct from `silent`/`notified` handling.
Checkpoint updates compare an immutable version. For another completed report
on the same receipt, pass its returned `checkpoint.version` as
`expectedCheckpointVersion`. If the base is stale, retain the newer checkpoint;
do not force an older interval over it. Its own exact inbox IDs can still be handled.

The user's explicit attention preferences take priority. "Tell me when finished"
usually means silent intermediate updates; "keep me updated" calls for meaningful
steps. Prioritize what the user is waiting on. Consolidate final outcomes instead
of announcing each tool turn. Valid asks, necessary decisions, substantive
blockers, failures, corrections and reversals must not vanish under routine
deduplication. Repetition alone needs no acknowledgement.

Use natural, topic-oriented language and reasonable analysis grounded in the
evidence, not mechanical relay. Preserve uncertainty and disagreements; do not
claim another session's actions as your own. Normal routing needs no fixed
acknowledgement or destination UUID. Explain actual errors or decisions.
Honor explicit requests to repeat, clarify or query again.

## Foreground selection

`assistant_foreground` queries or explicitly sets the sole notification ID.
Setting it requires an existing session; null disables reminders. It does not
grant or remove anyone's tool access. There is no first-human selection.
An unloaded selected session may be loaded for a necessary update using its
same ID; failed or unknown wakes are retained, not automatically retried.
Do not replace the foreground, move its history or change connector bindings
without user authorization.

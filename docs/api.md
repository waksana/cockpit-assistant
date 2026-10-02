# Directory and inbox API

Protocol **5**, schema **5**, no frontend. Discover the active module ID/digest
via Host `GET /_modules.active`; the API base is
`/_modules/assistant/<digest>/api`. Old mirrored-chat routes return
**410 NATIVE_CHAT_REQUIRED**. Native Chat belongs to the Host, not this module.

## Session setup

The ordinary `assistant/coordinator` role contributes its own HTTP MCP tools
and shared Skill instructions. It is not exclusive and does not install or
reference the Host MCP server. Provide the native MCP server named `cockpit`
separately, using a compatible Host installation's `launch mcp` entry and
intended endpoint/configuration. Isolated probes must use isolated homes and
endpoint; never copy production addresses or credentials into fixtures.

Create a new foreground with the role and an explicit immutable tool scope.
Assistant raw tools are exactly:

```json
{
  "name": "assistant",
  "tools": [
    "assistant_topics", "assistant_topic", "assistant_foreground",
    "assistant_inbox", "assistant_checkpoint", "assistant_resolve"
  ]
}
```

The external `cockpit` scope requires session creation, get/status, loading the
original ID, prompt/steering, native ask response and lightweight Chat reading.
Exact raw operation names are `cockpit_new_session`, `cockpit_get_session`,
`cockpit_reload_session`, `cockpit_send_prompt`, `cockpit_respond_ask` and
`cockpit_read_session_text` (public intent `session/chat/text`).
Do not expose unrestricted `cockpit_call_intent`,
delete, shutdown or deployment tools. No builtins are needed for these operations.

`cockpit_new_session` takes `tool_scope`; the public `session/new` intent uses
`toolScope`. Confirm the native MCP connection is enabled/connected, initialize
tools if necessary, then inspect actual configured/applied scope and offered
names through `session/tool-scope`. A saved role or enabled connection alone does
not establish that a model can call the tools.

An old immutable scope excluding `cockpit` does not gain it by removing the
role's exclusive policy. With user approval create a correctly scoped new
foreground; keep old history in its original session, never migrate it or
silently change connector bindings. Verify the new tools, then explicitly set
the ID through `assistant_foreground`. Production creation/selection/connector
changes require separate authorization; publication does none of them.

Module configuration `foregroundSessionId` supplies an existing explicit default.
A later persisted selection, including null, takes precedence. No first-human
selection occurs. Legacy `defaultCwd`/`worker` values remain readable but inert;
business session creation and resource selection now belong to direct Host calls.
The optional organizer role only contributes directory tools/instructions.
It has no custom `historySessionIds` source-authorization syntax.

## Tools

`POST /mcp` uses Host authenticated, digest-bound connection and native
`cockpit/invocation` metadata. Any caller already granted these tools by the Host
may use them, without coordinator membership, browser-origin proof or unrelated
role-binding availability checks. Invocation identities are not model-supplied
session arguments; Host access controls/tool filters remain unchanged.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `assistant_topics` | `{after?,limit?}` | Read identity/responsibility/scope metadata. |
| `assistant_topic` | `{topicId?,title?,content?,archived?,sessionId?}` | Edit metadata/register an existing session; omit topic ID to create an entry. |
| `assistant_foreground` | `{sessionId?:string\|null}` | Query/select one existing reminder ID, or disable with null; does not create/load. |
| `assistant_inbox` | `{ids?,after?,limit?,peek?,decisionsAfter?}` | List a bounded page of locations and current asks, with an exact inbox receipt. |
| `assistant_checkpoint` | `{receiptId,sessionId,readIds?,position,complete,gap?,reset?,expectedCheckpointVersion?}` | Save an agent-reported read position, distinct from handling. |
| `assistant_resolve` | `{receiptId,disposition:"silent"\|"notified"}` | Record handling of that returned inbox range; never sends or answers an ask. |

`assistant_dispatch`, `assistant_history`, `assistant_status` and
`assistant_read` are absent from discovery and return **TOOL_RETIRED** if called.
There is no hidden fallback, business routing, worker creation, Chat pagination
wrapper or general session-status interface.

Directory `contentUse`/warnings explicitly mark old descriptions as background.
Multiple topics may map to one session. Explicit registration requires an existing
native ID. Old delivery and creation receipts remain archived without startup
replay or replacement creation.

## Inbox and handling

Default page size is 50, maximum 100. `after` is the previously returned
`nextAfter` sequence; `hasMore` reports additional currently readable entries.
Items contain inbox ID, sequence, session ID, native message ID, optional exact
event/time source pointer, kind, candidate topics and wake facts. Current asks
contain only `questionRequestId`, never their question/options. New writes store
neither reply bodies, ask bodies, generated summaries nor tool results.
Read source Chat and current questions directly through Host tools.

Listing does not consume. `peek:true` only counts. A nonempty page gets one
receipt for exactly its returned inbox IDs, caller and time. Repeated listing
of the same range reuses its receipt. This records returned **locations**, not
proof of native Chat reading or model comprehension. Context loss can always
reread Host Chat independently of inbox state.

### Read positions

Before handling, call `assistant_checkpoint` for each source in the receipt.
`readIds` are exact returned inbox IDs, not all updates currently present.
`complete:false` stores resumable progress with no `readIds`; those updates
cannot yet be resolved. `complete:true` reports the intended range and all
fragments fully read. It is not a claim of full-history coverage.

For Chat, `position` is:

```json
{
  "query": { "source": "persisted", "direction": "backward" },
  "nextQuery": null,
  "hostCheckpoint": "actual-opaque-checkpoint-returned-by-host",
  "boundaryEventId": "actual-newest-fully-read-native-event",
  "coverage": "recent-window"
}
```

Store the Host's returned `checkpoint` as `hostCheckpoint`, distinct from the
local receipt's concurrency `checkpoint.version`. Query context preserves actual
`source`, `direction`, `cursor`, `since`, `bootstrap` and optional MCP budgets
`limit`, `max_bytes`, `scan_pages`. Store a returned Host continuation in `nextQuery`
with the same `since`, actual source, direction and cursor. Source and direction are checked, not inferred from cursor
bytes. The only direction transition is the Host's live backward bootstrap to
its actual forward continuation (`bootstrap:true` on the initial query).
Do not parse or fabricate opaque tokens. For asks read with `cockpit_get_session`,
`position:null` is allowed; ask IDs never become Chat checkpoints.

Persisted backward continuations seek older pages, not new updates. Resume them
for an interrupted interval. For a later update after completing that interval,
start a fresh backward text read with `since:hostCheckpoint` and no cursor.
Continue with the same `since` plus returned cursors until `hasMore:false` and
the Host returns its new `checkpoint`, after consuming every page/fragment.
Only then save that token. For the initial recent baseline, consume returned
pages/fragments until the Host offers a checkpoint; older history remains separate.
`boundaryEventId` is an optional comparison boundary (null when only the actual
Host checkpoint is available), never an input cursor or checkpoint.
Live forward continuation instead uses the actual live bootstrap cursor.
Switching source/direction requires explicit position rebuilding, not mixing
live/persisted tokens.

With no prior checkpoint, `coverage:"recent-window"` is mandatory in meaning
(and is the schema default); older unread coverage is unknown.
`coverage:"since-checkpoint"` requires a saved Host checkpoint or event boundary,
and the agent must finish the corresponding interval before claiming it complete.
Host `hasMore`/`scanLimited` and empty
filtered pages do not imply EOF. Use real continuations within a bounded relevant
range; do not scan all history or silently skip unfinished pages.

Record cursor expiry, rewind, deletion or a missing boundary in `gap`, with
`complete:false`. A later explicit `reset:true` starts rebuilt positioning.
On interruption or Host restart, recover the exact stored query/continuation or
completed Host checkpoint and submit it unchanged. Restart by itself does not
authorize `gap`, `reset` or replacing unread history with a recent window.
The Host's version-2 caller-owned position format removes the process-local
signing dependency. The Host validates position compatibility and native history;
Assistant neither decodes tokens nor reconstructs native locations. These are
positions, not authorization credentials, and Host identity/scope still apply.

If a native partial continuation expires or its page changes, explicitly retry
the incremental interval with the **same saved `since`**, without `cursor`.
Deduplicate already read fragments by `eventId` and offset. Preserve bounded
Host calls and all unread pointers until the interval is complete, then advance
the checkpoint by CAS. If a `gap` was recorded locally, `reset:true` explicitly
replaces that failed attempt with the same interval; it does not require or
authorize a new recent-only baseline. Missing or changed anchors and incompatible
positions remain actual gaps, not successful empty updates.

Legacy Host Rolling 36 positions were signed with a process-local key. The
corrected Host can accept the strictly parsed legacy payload as a caller-owned
location assertion and revalidate its native anchor/page, then return its new
format. This does not verify a lost legacy signature or guarantee recovery of
changed/deleted history. Submit the original token unchanged; do not decode,
rewrite or resign it in Assistant. Failed migration retains unresolved pointers.
Any explicitly chosen replacement baseline must disclose incomplete old coverage;
it cannot silently acknowledge all outstanding pointers.
Completed reports advance the per-caller/source checkpoint only if their original
base revision is still current. The default expected version is captured when the
inbox receipt is returned. To advance it again, pass the actual returned
`checkpoint.version` as `expectedCheckpointVersion`; identical reports return
`unchanged` without a new revision. A concurrent older report gets `checkpointState:"stale-base"`
without replacing the newer position. Its exact inbox IDs can still be handled.
Receipt `progress` and `sources` expose interrupted and prior completed positions.
Read positions are agent reports (`chatReadVerified:false`), not service re-reading
or certifying the Host response.

### Handling

`assistant_resolve` requires a completed, ungapped read report for every remaining
ID in the receipt, then records an explicit agent handling report. `notified` is
stored as `reported-notified`; results carry
`basis:"agent-reported-handling"`, `userDeliveryVerified:false` and
`chatReadVerified:false`. There is no output/hash/interaction certification or
physical-read guarantee. Only exact listed IDs are removed; concurrent arrivals
remain. New pointer rows are removed; original legacy body/snapshot rows stay
in-place as inert history with a bodyless archival marker. Existing native-ID
tombstones prevent duplicate callbacks from reviving handled entries. Semantic
duplicates with new IDs remain agent judgment.

Unresolved receipts whose items remain pending appear in `pendingDecisions`.
Paginate those with `decisionsAfter` using `nextAfter`/`hasMore`. Interrupted
handling remains recoverable; stale/elsewhere-handled rows cannot crowd out
actionable receipts. Inspect the original source and your own Chat before
repeating an uncertain user-facing presentation.

Current ask IDs are revalidated against loaded native state. Stale asks expire;
unavailable/unloaded asks remain pending without being presented as live.
Disposition itself does not answer a question. The agent uses the exact current
request ID with `cockpit_respond_ask`; attention/semantic decisions remain agent
guidance, not service original-text auditing.

## Foreground health and recovery

`GET /state` returns protocol/schema identifiers,
`inbox:"locations-and-handling"` and `health`.
`health.foregroundSessionId` retains the selected ID even when lookup fails.
`current` samples the target's native loaded/status/activity/ask with `checkedAt`,
or gives explicit unknown/error. This is inbox-target health, not a general
session-status wrapper and not a business completion assertion.
`lastWakeAttempt` separately preserves historical loading/loaded/failed/unknown
state and time; `pendingUpdates` counts source locations, not business tasks.
Passive health reads do not load/send or consult role-selection availability.

Ordinary updates await genuine source `session.idle`, known inactive work and
empty pending/steering queues; `assistant.turn_end` is not completion. Valid asks
bypass source-idle waiting. An eligible update may load the sole original
foreground. Loaded handles are never reloaded, deleted IDs are not replaced.
Source/foreground are rechecked before an idle `enqueue` location-only reminder.
An accepted wake is not a user-facing reply or business result.

Missing selected IDs report `FOREGROUND_MISSING`; failed reads retain their actual
error. Failed/unknown loads preserve pending updates and are not blindly retried.
An operator may inspect and explicitly load the same original ID through Host
tools; a later event can observe recovery. Unknown prompts remain unknown after
restart. No retry timer, replacement creation, keepalive or wake-reset API exists.

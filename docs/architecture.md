# Directory, inbox and one Skill

```text
User <-> native Assistant Chat -> Host MCP -> session create/load/prompt/ask
                  |                  +-----> native lightweight Chat/status
                  +-> Assistant MCP -> directory / inbox / handling
                  ^                         |
                  +-- enqueue update pointer+ <- registered source idle / ask
```

The agent owns interpretation, routing, session creation, prompt/steering,
native ask answers and user-facing expression. The module only supplies a
responsibility directory, inbox and their shared guidance. One explicit
foreground address and reminder flow belong to the inbox, not another session
manager. Native Chat and status are direct Host capabilities, not module wrappers.

Host invocation attribution, access control and tool scopes remain authoritative.
The module does not classify humans, inspect caller input, require coordinator
membership, check role availability each call or certify user delivery. A
connector's binding-change guard does not become an Assistant eligibility rule.
The role is ordinary and non-exclusive; external Host MCP resources are assembled
separately with exact creation-time scope.

## Persistence

Schema 5 retains its exact four table definitions:

| Table | Responsibility |
| --- | --- |
| `topics` | Identity, responsibility, scope and session mapping; retained legacy creation receipts. |
| `deliveries` | Inert legacy routing archive, never replayed on startup. |
| `mailbox` | New native event/message/ask pointers; legacy body/snapshot rows remain in-place as historical data. |
| `seen` | Native-ID tombstones, returned inbox ranges/agent handling, foreground selection and historical wake attempts; old routing/provenance facts are inert. |

Multiple topics can refer to a session. Explicit registration only accepts an
existing native ID. Old descriptions containing progress remain background,
not rewritten or promoted into current facts. Legacy deliveries and creation
fields are not replayed or reset on startup.

## Observation and handling

Only explicitly registered sources are observed. Reply content is represented by
native source pointers, not a transcript mirror. Primary nonempty message bodies
are eligible even when accompanied by tool calls; tool payloads/results and
subagent/ephemeral streams are not separate updates. Errors/aborts retain source
identities and do not establish success.

New ordinary updates wait for root `session.idle`, not `assistant.turn_end`.
Unknown activity, active work or queues and unloaded state cannot establish idle.
Recovered pending entries may use current native idle facts. A missed callback
does not justify inventing completion: the agent can read native Host Chat
directly, including after context loss or missed observations.

Current native asks bypass source-idle waiting. Ask request IDs are checked against
loaded live state; question bodies/options are read directly from Host `get_session`.
Stale asks expire, unavailable ones stay pending. Per-source
serialized observations and versioned samples reject stale asynchronous facts.
An inbox read may expose partial progress before idle; no business terminal-state
classifier exists.

Each bounded inbox page creates/reuses a bodyless receipt for its exact returned
IDs and captures prior source checkpoints. Listing does not consume.
Separate checkpoint reports retain actual Host query/continuation context and
opaque Host checkpoints (`since`), native cursor query context and optional
newest fully read event boundaries. Host tokens are distinct from the local
immutable checkpoint version used for compare-and-swap. Partial reads and gaps do not acknowledge
an interval. Expiration or source changes require explicit rebuilding; older
concurrent reads cannot overwrite newer completed checkpoints. Event IDs are
never passed as cursors, and backward/persisted tokens never become live forward
positions by reinterpretation. With no checkpoint, recent-window coverage is
explicitly limited. These are agent read reports, not a hidden Chat reader.
Explicit `silent` or `notified` is an agent report,
not proof source Chat was read or the user saw a response. Resolution removes
only those active IDs, never concurrent later arrivals. Handled legacy rows retain
their original bytes in-place and receive a bodyless archival marker; new pointer
rows can be deleted. Neither becomes a new chat mirror. Persistent native-ID deduplication
prevents duplicate callbacks from restoring handled rows. Interrupted handling
stays discoverable; stale receipts with no remaining rows do not block pagination.
Semantic novelty, attention and expression remain model decisions.

## Reminders and lifecycle

An explicit persistent foreground ID is solely a notification address. No
first-human selection or automatic history migration occurs. Only eligible
pending updates can load the same original ID; loaded handles are not reloaded.
Missing/failed/unknown outcomes never trigger replacement creation or blind
retries. Load intent is recorded before calling the Host, and native identity/
receipt readback stays separate from current health.

After revalidating source and target, an idle foreground receives a bounded
location-only `enqueue` prompt. A wake accepted by native runtime is not a final
reply or physical user delivery. Unknown sends remain unknown across restart,
without a poller, keepalive or replay timer. Unrelated roles are not requalified.

`shutdown.v1` stops new producers early, drains already-started calls while
storage remains open, then closes storage/releases the writer lease at disposal.
Retained data and offline migration are described in [releases](releases.md).

The [API](api.md) and shared Skill tell the agent to locate responsibility, read
current Host Chat, honor attention preferences and preserve uncertainty.
Guidance does not constitute a service authorization layer. `immediate` steers
an active run, not aborts it or clears its queue. Ask answers use exact live
request IDs through Host tools, not guessed dispatch text.

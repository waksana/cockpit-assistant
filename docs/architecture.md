# Directory, inbox and one Skill

```text
User <-> native Assistant Chat -> Host MCP -> session create/load/prompt/ask
                  |                  +-----> native lightweight Chat/status
                  +-> Assistant MCP -> directory / recent search / inbox / checkpoint / handling
                  ^                         |
                  +-- enqueue update pointer+ <- registered source idle / ask
```

The entrance owns conversational context, topic interpretation/routing and
faithful expression. Responsible sessions own concrete reasoning, research,
diagnosis and proposals, even when the subject is Assistant itself. The entrance
can understand references to route correctly, but cannot answer the business
question or add a solution under the label of summarizing. Only topic lookup and
summaries of recent contents or established progress remain at the entrance.
Only topic, request scope or discussion-versus-execution ambiguity is clarified there; business
questions continue in their responsible sessions. The shared Skill defines natural
incremental handoffs: preserve the user's wording and open questions, add only
missing context needed for understanding, and do not prescribe analysis directions
or extra requirements. Reply integration is faithful, without work-order templates
or routine attribution.

The agent uses direct Host tools for session creation, prompt/steering and native
ask answers. The module supplies a responsibility directory, recent-session
search, inbox and shared guidance. The unique coordinator role owner receives
reminders; there is no independently selected notification address. Native Chat
and status remain direct Host capabilities, not business execution wrappers.

Host invocation attribution, access control and tool scopes remain authoritative.
The module does not classify humans, inspect caller input, require coordinator
membership, check role availability each call or certify user delivery. A
connector's binding-change guard does not become an Assistant eligibility rule.
Coordinator identity is globally single-owner, enforced with Host serialized
role-assignment hooks. This is not `resourcePolicy: "exclusive"`: external Host
MCP resources are assembled separately with exact creation-time scope.

## Persistence

Schema 5 retains its exact four table definitions:

| Table | Responsibility |
| --- | --- |
| `topics` | Identity, responsibility, scope and session mapping; retained legacy creation receipts. |
| `deliveries` | Inert legacy routing archive, never replayed on startup. |
| `mailbox` | New native event/message/ask pointers; legacy body/snapshot rows remain in-place as historical data. |
| `seen` | Native-ID tombstones, returned inbox ranges/agent handling and historical wake attempts; old foreground selection, routing and provenance facts are inert. |

Multiple topics can refer to a session. Explicit registration only accepts an
existing native ID. Old descriptions containing progress remain background,
not rewritten or promoted into current facts. Legacy deliveries and creation
fields are not replayed or reset on startup.

### Independent recent-message cache

`recent.sqlite` schema 1 is a rebuildable discovery copy with bounded text,
source metadata, successful synchronization markers and a durable pending queue.
It is neither authoritative Chat nor a second inbox. Its contents do not prove
that an agent read a conversation or that a reply was presented to the user.

At service readiness, startup begins a background, paginated public session
inventory. A serial worker yields between jobs and advances inventory between
batches so a busy source cannot indefinitely prevent discovery of other sessions.
It compares the source's timestamp/provenance and a one-event native head probe
with the successfully synchronized source state. Unchanged sources skip the full
scan; local wall-clock time never stands in for a source checkpoint. A refresh
reads at most eight 16-event persisted pages plus two one-event head probes,
normalizes page orientation and validates source state before publishing.
Normal source drift permits one bounded retry, then remains explicitly stale
until a later event/startup; genuine access, cursor and format failures remain
reported. No periodic source polling, model wake or business prompt is involved.

Primary conversation events and content/identity changes invalidate the cache.
Activity-only patches from the cache's own native reads do not trigger refresh.
Rewind/compaction invalidation removes the cached text before rebuilding; deletion
removes the entry. Inventory prunes absent sessions only after complete enumeration.
Generations fence in-flight publication and search, and shutdown drains both
worker and search reads before storage closes.

Source metadata plus a head probe cannot detect every arbitrary offline edit to
interior history when both markers remain unchanged. Cached matches therefore
always require direct native confirmation. The public raw reader limits **event
count**, not inbound transport bytes; retention and search output are bounded,
but this module cannot promise a byte cap on a single returned native event.
See [search API and budgets](api.md#recent-session-discovery).

## Observation and handling

Only explicitly registered sources contribute inbox updates. Reply content is represented by
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

The public Host session directory's saved coordinator role is the reminder
authority. No owner is unconfigured; multiple pre-existing owners are an explicit
conflict, not permission to pick one. New assignments cannot create a second
owner. Loaded owners must actually have the role applied; stale saved labels do
not imply readiness. Role callbacks inspect public state only, without loading
or prompting from the assignment transaction. No first-human selection,
automatic role change, connector rebinding or history migration occurs. Legacy
foreground configuration and receipts are retained but ignored. Only eligible
pending updates can load the same original ID; loaded handles are not reloaded.
Missing/failed/unknown outcomes never trigger replacement creation or blind
retries. Load intent is recorded before calling the Host, and native identity/
receipt readback stays separate from current health.

After revalidating source and target, an idle foreground receives a bounded
location-only `enqueue` prompt. A wake accepted by native runtime is not a final
reply or physical user delivery. Unknown sends remain unknown across restart,
without a poller, keepalive or replay timer. Unrelated roles are not requalified.

Native/control event callbacks are independent observations, not prompt
middleware continuations. The Host must isolate their middleware recursion
context before delivery. Assistant has no middleware `next` to call and does
not bypass the Host guard. If a Host call throws after a notice is reserved,
including a pre-dispatch guard rejection, the original notice stays `unknown`
and its inbox sources remain available; later events do not retry it. A Host
fix prevents future false recursion failures but does not settle or replay
existing unknown notices.

`shutdown.v1` stops new producers early, drains already-started calls while
storage remains open, then closes storage/releases the writer lease at disposal.
Retained data and offline migration are described in [releases](releases.md).

The [API](api.md) and shared Skill tell the agent to locate responsibility, read
current Host Chat, honor attention preferences and preserve uncertainty.
Guidance does not constitute a service authorization layer. `immediate` steers
an active run, not aborts it or clears its queue. Ask answers use exact live
request IDs through Host tools, not guessed dispatch text.
Session selection starts with the current goal and intent, then identifies actual
responsibility using the directory, recent search and relevant composed discovery
capabilities. Clearly relevant candidates are not excluded by recent snippets alone;
scope corrections reopen the comparison, not automatically the execution. Native
Chat and current activity/queues establish context and suitability, not a substitute
for enduring scope. An existing integration owner retains business decomposition
and its concrete execution owners; a batch of independently owned deliveries instead
needs only the authorized remaining handoffs. This is shared agent guidance, not a
dispatch gate, scheduler, workload score or hard dependency on another module.
Queue acceptance does not establish suitability.

## Routing examples and evaluation boundary

| Input | Expected entrance behavior |
| --- | --- |
| "Find our export topic" / "What has changed recently?" | Locate topics and summarize actual recent evidence without starting new business work. |
| "How should the export work?" | Reuse a suitable export session, or search recent candidates and create only if none fits. Do not ask about devices or propose formats at the entrance. |
| "Why are you analyzing business questions yourself?" | Resolve "you" to Assistant coordinator and select a session matching this routing discussion, not a catch-all product owner; do not first diagnose the Skill. |
| "Why did you send such a long message?" continuing a routing discussion | Continue the question in the suitable discussion session, resolving "you" to Assistant only if needed and adding only missing facts about the message. Do not append an analysis agenda, required recommendations or a reporting template. |
| "Is Assistant inbox broken?" | Select a session responsible for this inbox question using scope, continuity and current-work evidence; do not inspect inbox health at the entrance as a diagnostic shortcut. |
| An independent Assistant role question while a product-related session implements another change | Prefer a matching existing discussion session; only after necessary lookup finds none suitable, create an ordinary session for that specific discussion. Do not default to the implementation queue. |
| An integrated goal spans several areas and a clearly relevant candidate's recent snippet covers only one subtask | Use relevant available discovery guidance and native Chat to establish the candidate's actual scope. If it already owns integration, continue there and retain its execution owners rather than splitting the goal at the entrance. |
| The user corrects a partial request to an overall goal after one recipient was chosen | Reconsider the relevant candidates and responsibility evidence, not just the first recipient's current work. The correction alone does not authorize duplicate dispatch or cancellation. |
| Current evidence already establishes a suitable recipient | Reuse it; do not require another metadata lookup or a full directory scan merely to satisfy a checklist. |
| A correction, constraint, material or answer needed by an active execution | Keep the executing session as recipient despite its workload; answer its exact current ask or choose enqueue/authorized steering according to urgency and intent. |
| A candidate is `running`, has a shell or has been active for a long time | Combine recent native Chat goals/phases with current activity and queues; no one signal proves heavy work, and unknown activity does not prove idle. |
| A busy candidate has a superior or several related sessions | Do not mechanically escalate or broadcast; select the specific recipient needed for each necessary action. |
| "Merge both changes, then deploy" when one change is already merged and published | Preserve each source/rework responsibility, reuse completed evidence and dispatch only authorized remaining work. Confirm prerequisites before a dependent stage; a shared operation's executor does not inherit all source ownership. |
| "Should these be separate topics, with deployment afterwards?" during a discussion of the Assistant's working method | Interpret the surrounding conversation; clarify discussion-versus-execution intent if ambiguous before changing execution. Do not turn the example into reassignment, retries or a message to every owner. Separate topics do not require new sessions. |
| "Change that" with multiple plausible topics | Clarify which topic/object, not implementation details. |
| A responsible session asks a business question | Present its actual question naturally and return the user's answer to that session; do not invent additional business questions. |
| A source reports a proposal or partial result | Integrate it naturally as a proposal or partial result, not completed work or the entrance's new recommendation. |

Packaged-guidance assertions protect these explicit boundaries; deterministic
native probes exercise tools, roles, reminders and read positions. Neither proves
that every real model will spontaneously obey the routing policy in conversation.

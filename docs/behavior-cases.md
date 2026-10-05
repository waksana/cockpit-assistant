# Assistant behavior cases and guidance history

This is a retrospective, not a new routing policy or a claim that the Assistant
now behaves correctly. It records recoverable failures, the evidence for their
causes, and the changes intended to address them. The source baseline is
[`3664ed9`](https://github.com/waksana/cockpit-assistant/commit/3664ed9e94f9e6fb2433dfaef13481107197e7c2),
including Assistant #46 and the separately maintained Task advisor #137.
Dates below use UTC+08:00.

## Evidence, privacy and coverage

The private conversation evidence is paraphrased, not published as a transcript.
Names of business systems and assets are generalized. Account information,
private decisions, credentials, machine paths, native session/message identifiers,
and operational receipt identifiers are intentionally omitted. Public PRs,
Issues and commits locate the repository changes; they do not make the private
incident evidence publicly reproducible.

Keep the following evidence levels separate:

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Recovered user report or correction | What the user reported and the intended scope | Every reported tool call or a model-internal cause |
| Recovered Assistant reply or contemporaneous investigation | What the agent said it did or concluded at that time | Independent confirmation of all underlying operations |
| Recovered native tool trace | The particular calls, ordering and results that were actually read | Unread history or all possible causes |
| Public Issue, PR or review report | The developer's published observation or diagnosis | The original production transcript unless included |
| Source and deterministic regression | A mechanism and the exercised code path | Spontaneous model judgment or user receipt of an answer |
| Controlled native integration | Real Host/MCP/session behavior under a controlled provider | Production semantic routing quality |
| Bounded real-model sample | The behavior reported for that limited sample | General compliance, especially without its full transcript |
| Merged guidance and published package | The instruction change and its packaged identity | Installation, applied session instructions or a behavioral fix |

Unless a case explicitly says otherwise, a post-change autonomous replay of the
original case under confirmed applied guidance was **not recovered**. A successful
cleanup, later user-directed lookup, passing text assertion, or Rolling Release is
not substituted for that missing evidence.

The audit includes two complete forward traversals of persisted primary text:

| Private source, anonymized | Recovered interval | Coverage |
| --- | --- | --- |
| Development/routing discussion | September 30, 22:20 through the October 6 documentation request | 8 bounded calls, 127 native pages and 2,026 scanned events |
| Unified entry conversation | October 3, 06:27 through October 6, 07:07 | 41 bounded calls, 655 native pages, 10,474 scanned events and 229 text messages |

Both traversals reached their available tail without a continuation gap or
truncated text fragment. These are API scan counts, not a separate count of
unique raw events. Tool payloads, reasoning, tool-internal question/answer
payloads and other business sessions were not exhaustively reconstructed.
Statements about sending, withdrawing, loading a Skill or reading metadata
remain **reported actions** unless stronger evidence is identified.

The repository review traversed all 62 commits reachable from the baseline
(26 first-parent entries and 40 non-merge commits), 142 historical paths, and
the 25 PRs through #46, including their public discussions and linked Issues.
PR numbers are not a count of PRs. Before #18, guidance lived in roles and
embedded prompts; scanning only today's Skill would miss it. Deleted `memory`
and `worker` roles, earlier MCP descriptions, intermediate PR revisions, and
the companion Task advisor history were included.

## Recovered conversation cases

These are incident chains, not one incident per PR. The same PR can address
different cases, and the same case can require several revisions.

| Case | Distinction to preserve |
| --- | --- |
| [B01: no discovery before creation](#b01-creating-a-new-topicsession-without-checking-existing-context) | No lookup in the recorded investigation, unlike B08's discovered-but-dismissed candidate. |
| [B02: entrance business design](#b02-business-design-performed-at-the-entrance) | Discussion without implementation still crossed the established role boundary. |
| [B03: entrance self-diagnosis](#b03-diagnosing-assistants-own-components-before-routing) | A self-related product question was not an exception; the admitted investigation was not tool-replayed. |
| [B04: heavy-worker catch-all](#b04-independent-questions-queued-behind-unrelated-heavy-work) | Same product was mistaken for the same concrete responsibility. |
| [B05: joint ownership](#b05-a-joint-delivery-framed-as-transfer-of-all-responsibility) / [B06: workflow intent](#b06-a-discussion-about-workflow-treated-as-a-new-execution-arrangement) | Two errors in the same delivery discussion; not evidence of two deployments. |
| [B07: question turned into work order](#b07-an-ordinary-follow-up-expanded-into-a-management-work-order) | Unrequested requirements, not length alone, were the problem. |
| [B08: integrated goal fragmented](#b08-an-integrated-goal-fragmented-while-its-existing-coordinator-was-missed) | Premature split, candidate exclusion and selective advisor use were stages of one episode. |
| [B09: blocker boundary](#b09-a-blocker-responsibility-question-that-was-not-established-as-a-misroute) / [B10: withdrawn coupling proposal](#b10-a-module-coupling-proposal-corrected-before-implementation) | Recovered design discussions, not proven deployed defects. |

### B01. Creating a new topic/session without checking existing context

**Context and error.** On September 30, the user asked whether Assistant checked
existing sessions before creating a topic, and whether an initial scan was
necessary. The contemporaneous investigation reported that the running
Rolling.7 coordinator made no topic, session or history lookup before creating
the topic; an unbound topic then caused a new session to be created. The user
had requested investigation, not a full historical scan.

**Evidence and cause.** The original question and investigation are recovered.
The recorded mechanism was that startup enumerated session metadata, not the
contents of old conversations; discovery tools were available but optional, and
the backend creation path did not independently find an existing owner. The
original coordinator tool sequence was not independently replayed in this
audit. This supports a discovery gap in that instance, not a claim that every
request created a session.

**Changes.** Discovery evolved through the ordinary-session guidance, then the
bounded recent-message index in [#39][pr39]. [#42][pr42] made topic reuse and
session reuse separate decisions. [#46][pr46] put actual responsibility
discovery before recipient selection and allowed relevant composed discovery
capabilities. The earlier suggestion to make backend matching mandatory was a
proposal, not the implementation ultimately delivered.

**Status.** The later source provides discovery capabilities and stronger
selection rules. No full historical initialization was authorized by this
question, and no autonomous replay proving correct reuse was recovered.

### B02. Business design performed at the entrance

**Context and error.** On October 3, a user asked for a durable, editable
conversation archive. The entry Assistant directly proposed storage formats,
attachment handling and structured-data relationships over two replies.
The user corrected it: identify the topic and continue the business discussion
in a responsible session, even when no implementation has yet been requested.

**Evidence and cause.** The entry's substantive design replies and the user's
correction are recovered, so the scope violation is visible in the text itself.
The entry explained that it had treated "only discussing, not writing code" as
an exception to routing, while acknowledging that the deeper cause still
needed investigation. That explanation is an agent account, not proof that it
had failed to load any particular instruction.

**Changes.** Earlier [#18][pr18]/[#20][pr20] already reserved business thinking
for responsible sessions. [#39][pr39] subsequently made route-before-investigation
explicit and disallowed business analysis under the label of conversational
organization. Its removal of a looser evidence-grounded-analysis allowance is
a traceable clarification. The recovered discussion and the public revision
address the same boundary; no public link independently proves this exact
private exchange was the PR's sole trigger.

**Status.** The entry reported creating a business discussion session and
referring its own behavior for investigation. That handoff is reported, not a
tool-level replay. The next case shows another boundary admission minutes
later, before the subsequent publication; it is not a demonstrated regression
of an already-applied #39 fix.

### B03. Diagnosing Assistant's own components before routing

**Context and error.** Minutes after B02, the user asked whether update delivery
was working. The entry acknowledged that it had again investigated first,
instead of routing the diagnosis to a responsible session. The user reiterated
that the entrance could handle topic lookup and recent-content/progress
organization, not concrete business or product diagnosis.

**Evidence and cause.** The user question and the entry's admission are
recovered. The underlying diagnostic calls are not in this audit's primary-text
view. The question alone does not prove an inbox defect, and the complete
immediate context may include tool-internal exchanges not returned as primary
text. The supported failure is the admitted boundary crossing, not a newly
invented missed-notice incident.

**Changes.** [#39][pr39] explicitly includes Assistant, its Skill and inbox in
route-before-investigation, while distinguishing routine inbox collection
from diagnosis of inbox failure. The later [#42][pr42] also removed wording
that could turn a familiar Assistant development session into a catch-all
destination.

**Status.** The entry reported handing the question onward. No independent
diagnostic-call reconstruction or post-application behavioral replay was
recovered. The related natural-conversation expectation stated in this exchange
is also relevant to B07.

### B04. Independent questions queued behind unrelated heavy work

**Context and error.** On October 5, two questions about roles and conversation
routing were sent to a product-related session implementing a different
capability. The entry point had already observed it running before the first
send; the second question followed the same destination. They were independent
discussion, not corrections or materials required by that implementation.

**Evidence and cause.** The recovered coordination report describes two pending
queue items, and the contemporaneous investigation describes the recipient's
actual implementation/release work. The error was broad product matching plus
confusing queue acceptance with suitability. Existing guidance said to reuse a
suitable session without spelling out this distinction. Its broad product-owner
wording is a plausible contributor supported by the text, not a proven account
of the model's internal reasoning. A `running` flag alone would not establish
heavy work.

**Changes.** [#42][pr42], source commit
[`c2d4fee`](https://github.com/waksana/cockpit-assistant/commit/c2d4feedd03030bc9e6a9e73becc271a73d0e02c),
added specific responsibility and continuity, native work goal/phase plus
activity/queues, and the split between independent discussion and
execution-required feedback. It prohibited mechanical escalation or broadcast
and did not introduce a workload score.

**Status.** The pending items were reported removed without aborting the ongoing
work, and discussion continued in an existing relevant session. This is recovery
from the incident, not proof of a general behavioral fix. Later that day, the
entry described separating unrelated runtime investigation from ongoing Skill
work. That is a positive reported analogue, not independently confirmed tool
behavior or evidence that the newly published guidance caused it.

### B05. A joint delivery framed as transfer of all responsibility

**Context and error.** On October 5, a combined merge/release/deploy request was
handed to one session as the sole operations owner. There were already separate
source owners, and one component had already merged and published. The user's
follow-up challenged whether the original responsibilities had been preserved.

**Evidence and cause.** Both the incoming combined-delivery handoff and the
correction are recovered. A single executor for the shared deployment could be
valid; the problematic part was unqualified ownership wording and insufficient
separation of source/rework responsibility from the remaining shared operation.
This is not evidence that the already-completed merge was actually repeated.

**Changes.** [#43][pr43] introduced concrete ownership, stage evidence,
dependencies and only necessary authorized remaining actions. Its follow-up
[`ad63f6e`](https://github.com/waksana/cockpit-assistant/commit/ad63f6e1fdf34ba8e802cb80c0c4ab9bd0d67e96)
clarified that a one-sentence "handle everything" request determines neither
recipient count nor dispatch count, and does not include unrelated history.
Topic separation does not require new sessions or a message to every owner.
The wording clarification was part of this chain, not a separate recovered
incident or a request for a slash-command feature.

**Status.** Existing completion evidence was reused in the recorded delivery.
The later [#46][pr46] refinement distinguishes an existing integration owner
from separately owned deliveries; it does not reverse the ownership rule.
At noon, another short joint request received a visible response preserving the
source owners and deferring shared deployment until their artifacts existed.
This is a useful local positive observation and reported handoff, not a
tool-verified acceptance test of already-applied new guidance.

### B06. A discussion about workflow treated as a new execution arrangement

**Context and error.** In the same October 5 delivery discussion, the user asked
whether work should be separated and deployment follow later. The entry point
made an operational handoff before resolving whether this was a critique of
its working method or an instruction to change the current execution. The user
then explicitly said the request was to study Assistant behavior, not deploy
again.

**Evidence and cause.** The correction and contemporaneous analysis are
recovered. A phrase describing a possible sequence can sound imperative when
isolated; the surrounding discussion was material evidence of intent. The old
topic-only clarification boundary was too narrow for this ambiguity.

**Changes.** [#43][pr43], beginning with
[`d4d9fde`](https://github.com/waksana/cockpit-assistant/commit/d4d9fde4b8a90d19938dd30fc73b9c2e77e966d1),
aligned the Skill and coordinator: clarify discussion-versus-execution intent
when unclear; examples, hypotheses and workflow corrections do not themselves
authorize retry, reassignment, resume or cancellation.

**Status.** The deployment recipient reported checking the already-successful
operation rather than submitting another deployment. Avoiding duplicate side
effects limited the consequence but did not make the intent decision correct.
Do not describe this case as a proven duplicate deployment. Subsequent replies
correctly kept the one-sentence-rule clarification and the blocker question
(B09) at the discussion level. These visible local improvements do not prove
stable compliance or independently establish all tool effects.

### B07. An ordinary follow-up expanded into a management work order

**Context and error.** On October 5, a short question about responsibility was
relayed into an existing discussion as a long message containing background,
an analysis agenda, requirements, restrictions and expected delivery. The user
wanted one natural conversation, not an apparent manager-to-worker assignment.

**Evidence and cause.** The complaint and the actual long incoming message are
both recovered. Preserving the no-action boundary was appropriate; inventing
the structure and direction of the answer was not. Natural-handoff guidance
already existed. The investigation identified underspecified "enough
background" wording as a contributor, not a proven sole cause.
The user had explicitly stated the continuous-conversation expectation on
October 3. This is a later return of the unwanted style relative to that
expectation, not proof of a failed deployed-fix regression. An earlier long
handoff artifact that the user explicitly requested is excluded: length alone
does not define the defect.

**Changes.** [#30][pr30] and [#39][pr39] already discouraged mechanical relay and
work-order framing. The first part of [#46][pr46],
[`3845c33`](https://github.com/waksana/cockpit-assistant/commit/3845c33e3d8002cf07d7664a130378755ec2cb82),
made the boundary explicit: preserve wording, tone and open questions; add only
necessary missing context; do not prescribe analysis directions, conclusions,
deliverables or extra requirements. The recipient continues answering the user,
not reporting to the coordinator. Genuine execution handoffs still retain
necessary scope and authorization limits.

**Status.** The published guidance and generated coordinator include the
change. No post-application replay of the same natural follow-up was recovered.
Repeated strengthening of this rule is not, by itself, a count of separate
production incidents.

### B08. An integrated goal fragmented while its existing coordinator was missed

**Context and error.** On October 5, the user requested an integration spanning
data, analytics and dashboard/runtime responsibilities. Assistant first sent
parts to a query session and a newly created specialist, then asked the user
to resolve internal technical dependencies. After being told this was one
overall goal, it placed coordination with the first partial recipient.

Search had already returned an existing long-lived integration session. It was
dismissed on the strength of a recent summary about a narrower dashboard
delivery, without checking its full context. Only after the user named it were
its previous integration work and current complete responsibility definition
reported read. The reported definition explicitly covered the relevant coordination,
preserved the concrete executors, and allowed idle periods.

**Evidence and cause.** The recovered user reports specify the sequence:
initial directory/recent search without the available responsibility
cross-check; after correction, an advisor reload and a lookup limited to the
first recipient's unfinished work; finally the named integrator's full
definition. The investigating session explicitly acknowledged that its first
two explanations relied on those reports before it read the advisor text.
Those explanations must not be presented as independent tool verification.
The entry's own later admissions corroborate the same account, including its
earlier use of the advisor and its selective check after correction. Neither
thread's primary-text traversal independently verifies the full tool sequence
or the external integration session's original agreement.

The supported decision failure is early exclusion of a relevant candidate,
followed by confirmation of the first choice rather than reconsideration.
Recent activity was treated as complete responsibility, and partial execution
as evidence of overall ownership. Existing rules already rejected those
shortcuts. The investigations also found underspecified cross-check triggers,
stopping criteria and long-lived-agreement interpretation. Saying "the Skill
was not loaded" or "the Skill was bad" would overstate the evidence.

**Changes.** The second part of [#46][pr46],
[`c118136`](https://github.com/waksana/cockpit-assistant/commit/c11813600be79fa1687c66b8258ef7737c700a8d),
reorganized the existing selection flow around goal, responsibility evidence,
current suitability and necessary handoff. It preserves an established
integration owner and leaves business decomposition there; it does not make
one recipient the default for every joint request.

The companion [Task #137][task137],
[`0c63637`](https://github.com/waksana/cockpit-task/commit/0c63637239b34584c031452786a47879234544ca),
integrated bounded full-definition/relationship reads, candidate reconsideration,
and long-lived responsibility into the generic read-only advisor. It preserves
the busy executor's necessary feedback and does not mechanically escalate to a
parent. Assistant contains no Task API, tree or role dependency; native Chat
remains the business conversation source.

**Status.** User-directed discovery recovered the missing responsibility.
The entry subsequently reported that the prematurely created coordination work
and subtasks had not yet been connected to the long-lived owner; no explicit
completion of that responsibility repair was recovered in the reviewed text.
Assistant Rolling.24 and Task Rolling.12 contain the revised instructions.
Neither is evidence that autonomous selection now succeeds without the user
naming the right session.

### B09. A blocker-responsibility question that was not established as a misroute

**Context.** After deployment preparation failed for lack of space, the user
separately authorized bounded storage investigation and low-risk cleanup. The
same deployment session received that work. The user then asked whether
removing a blocker meant owning general host storage maintenance.

**What can be concluded.** The discussion is recovered, but assigning the same
session was not established as an error. That session could legitimately accept
the separate authorized work. Failure-specific cleanup and broader maintenance
are different responsibilities; sharing a recipient does not merge them.
The discussion did not establish why the disk had filled or authorize a
deployment retry.

**Change and status.** A generic blocker/ownership principle was proposed, then
explicitly deferred. It was not added to Assistant #46 or Task #137. This entry
preserves an unresolved boundary discussion, not a fabricated defect, fix or
disk-cleanup result.

### B10. A module-coupling proposal corrected before implementation

**Context and design error.** On October 5, the user wanted responsibility
metadata and collaboration guidance available through role composition.
The discussion moved toward putting Task-specific rules into Assistant and
changing the business-fact-source boundary. The user rejected that direction;
the entry withdrew those suggestions and acknowledged that they had not been
implemented.

**Evidence and cause.** The user correction and withdrawal are recovered
design evidence. They do not establish that coupled code was deployed or
that Assistant actually took over Task authority. The distinction is between
using another module's capabilities and making that module's concepts part of
Assistant's intrinsic routing system.

**Changes/status.** [Task #135][task135] delivered a general read-only advisor
through composition. [#46][pr46] and [Task #137][task137] later refined the
cooperation while retaining independent guidance and authority boundaries.
The source history demonstrates those boundaries; the original proposal is
recorded as corrected before implementation, not as a runtime incident fixed
by a rollback. Module decoupling is not evidence that the model will actually
use the composed guidance, as B08 demonstrates.

## Publicly recoverable implementation and integration cases

These explain user-visible failures or risks around the conversation, but should
not be relabeled as model-routing incidents. Where no original user conversation
was recovered, that limitation is explicit.

### T01. Duplicate role wakes and incomplete delivery to an unloaded recipient

[Issue #11][issue11] and [#12][pr12] describe two related delivery mechanisms.
The old wake key incorporated the changing pending-work fingerprint, allowing
new work to generate more reminders while an earlier wake remained unconsumed.
The correction coalesced by role/session/epoch and kept accepted or unknown
wakes occupying their slot. A deterministic regression processed 21 different
inputs with one coordinator reminder, then allowed another after drain.

The other correction made the backend prepare the exact selected session before
sending the original payload. A routing decision was not enough if an unloaded
recipient never received it. Regressions covered loading, lost acknowledgements,
busy queues, uncertain creation and partial multi-recipient success without
duplicate sends.

**Cause/status.** Source and regressions support these mechanisms. The original
production wake sequence and user conversation were not recovered publicly.
[#12's review record](https://github.com/waksana/cockpit-assistant/issues/11#issuecomment-5887367060)
is not proof that a user had repeatedly been asked to restate the request.
These were backend/role changes before the shared Skill existed.

### T02. Oversized history output prevented useful topic discovery

[Issue #25][issue25] reports that an organizer tried to process 215 selected
sessions, but raw 16-event pages exceeded the native MCP output budget. Results
were moved into a file the tool consumer could not read, hiding the continuation
cursor as well; only three sessions had partly readable history.

[#26][pr26],
[`8b7c3ea`](https://github.com/waksana/cockpit-assistant/commit/8b7c3ea94f479f23ea2370f741bfd85c683c5727),
returned at most three recent nonempty primary messages with serialized-size
limits, provenance and explicit truncation/coverage flags, instead of raw tool
and reasoning payloads. Organizer guidance remained recent-only rather than
silently expanding into all history.

**Cause/status.** This is a public developer incident report supported by the
old/new API behavior and payload regressions. The original complete organizer
tool trace and a successful rerun of all selected sessions were not recovered.
Rolling.12 publication is not that missing acceptance record. Later #36 replaced
the Assistant history wrapper with direct Host reads.

### T03. Forced worker configuration broke ordinary session creation

[Issue #27][issue27] attributes default creation failures to the injected
worker-only tool configuration. [#28][pr28],
[`721d810`](https://github.com/waksana/cockpit-assistant/commit/721d810cfe796fd5efb02c78f594ea703685f7ba),
retired the worker role and the exact old built-in preset, using ordinary
session defaults without silently discarding custom selections.

The change retained any created identity and the failed stage, distinguished
whether a prompt had been attempted, and prohibited replacement creation or
resending an uncertain operation.

**Cause/status.** The published diagnosis and source establish the configuration
problem; the original full failure receipt was not recovered, so no particular
custom alias is declared its sole cause. Isolated native tests covered ordinary
creation, tool initialization, binding and first reply with a synthetic
provider. They did not retry the original business request. This changed role
and creation behavior, not the shared foreground Skill.

### T04. A model turn end was mistaken for a complete response interval

[Issue #29][issue29] records controlled native observations: both tool turns and
final model turns emitted `turn_end`, queued inputs could run without an idle
gap, and an experimental completion receipt did not produce the expected event.
The selected boundary became source-session idle, not a new cross-repository
completion protocol.

[#30][pr30] accumulated source replies until root idle with known inactive work
and an empty queue; current native asks were the explicit exception. It also
used queued foreground notices and documented authorized steering separately
from cancellation. Idle did not establish business success.

**Cause/status.** Real native queue/event/steering probes with a controlled
provider established the mechanism. Eight real model-helper samples were also
reported for repetition, corrections, state changes and failure/unknown cases,
but their full transcripts were not recovered and they were not production
foreground evaluation. Do not invent a production duplicate-notification
incident from those samples.

### T05. Several distinct races could suppress or outlive notices

This is a mechanism family, not evidence that one production bug repeatedly
recurred:

| Revision | Recovered mechanism | Correction/evidence boundary |
| --- | --- | --- |
| [#20][pr20], [`331bbcc`](https://github.com/waksana/cockpit-assistant/commit/331bbcc999b10be6ecf891a72ec6bb1761eaba22) | Follow-on notice sends escaped the awaited chain; work after an asynchronous boundary could continue during shutdown. | Awaitable draining and stop checks; source/review regressions, not a recovered user incident. |
| #20, [`7c0181b`](https://github.com/waksana/cockpit-assistant/commit/7c0181b8d21a91c75f2392a2a2a6e3b09d0c3a93) | A result could join a loop that had exited before its cleanup cleared the stored promise. | Same-continuation cleanup and a deterministic wake-exit regression. |
| [#32][pr32] | An unloaded foreground needed an eligible pending notice to load the original identity; changing resources and shutdown complicated eligibility. | On-demand exact-identity load, persistent uncertain outcomes and resource-version fencing; no original production trace recovered. |
| [#39 review](https://github.com/waksana/cockpit-assistant/pull/39#issuecomment-5963965184) | A later passive discovery could clear owner evidence needed by an eligible notice waiting on the previous discovery. | A reported deterministic reproduction and ordering fix; not evidence for the cause of every missed notice. |

### T06. Restart recovery initially required a lossy recent baseline

The published [#36][pr36] guidance said a Host process restart invalidated read
positions and required a new recent baseline with a coverage gap. A
[same-delivery correction](https://github.com/waksana/cockpit-assistant/issues/35#issuecomment-5955761588)
required ordinary full Host restart to preserve the unread interval.

[#37][pr37], with the corresponding Host changes, switched to stable caller-owned
positions. The original `since` must survive recovery; changed/expired partial
pages require rereading that interval and reconciling fragments, not replacing
it with the newest few messages.

**Cause/status.** This is an explicit old protocol limitation and its correction,
not proof that particular production messages were lost. Controlled native
evidence covered six actual Host process exits/restarts, multi-page intervals,
Unicode fragments, a real changed-page result, a rewind gap and legacy
positions. Actual cursor expiry and initial traversal without a completed
checkpoint were explicitly not induced. These probes validate mechanisms, not
the model's spontaneous choice of the correct recovery strategy.

### T07. A neutral role conflicted with Assistant's single-role assumption

[Issue #33][issue33] and [#34][pr34] changed the old "exactly one role in the
whole array" assumption to one Assistant identity plus Host-compatible neutral
roles. The old cold-load check can be verified in source.

**Cause/status.** The implementation limitation is established; a specific
original connector failure receipt was not publicly recovered. The reported
role-combination tests were synthetic. [#36][pr36] later retired Assistant's
internal resource/role eligibility audit. [#39][pr39] made coordinator ownership
unique without restoring resource exclusivity. Saved roles, applied resources
and actual readiness remained different facts.

### T08. A false recursive-prompt rejection blocked a notice

[Issue #44][issue44] and [#45][pr45] record a bounded observation on October 5
of `Recursive host.call(prompt) is forbidden; use next`. The backend remained
active, and later distinct notices had native receipts. This does not attribute
all older unknown notices to the same error.
The entry's primary text also contains the user's error report and a later
relay of the diagnosis. The exact timed failing tool call was not independently
read; the technical attribution comes from the public investigation and code
regressions, not from that relay alone.

The published diagnosis and fix are in [Host #299][host299]: independent event
observers inherited a middleware recursion marker, so a legitimate observer
prompt was mistaken for a recursive continuation. The Host isolated that
observer context without disabling the real recursion guard.

**Change/status.** Assistant #45 added a regression and documentation, not a
Skill or runtime change. A pre-dispatch rejection still leaves the reserved
notice unknown, keeps source pointers available, and does not trigger replay.
Host regressions reproduced the false rejection in the old implementation.
Rolling.23 packaging does not settle old unknown operations or prove final
user delivery.

### T09. Native-only cutover exposed two different release-contract failures

**Packaging.** [Issue #21][issue21] records that the actual Rolling packager
still read the deleted frontend entry after [#20][pr20]. Other tests and package
closure checks had passed. Rolling.9 failed; there was no Rolling.9 Release.
[#22][pr22] exercised and corrected the actual immutable package builder.

**Deployment descriptor.** [Issue #23][issue23] records that the resulting
Rolling.10 descriptor listed multiple automatic source migrations for one
database, while its consumer accepted one. Plan construction failed before
production stop or installation. [#24][pr24] kept the supported automatic
4-to-5 declaration while retaining the separate offline migration tool.

**Cause/status.** Both are public implementation reports with specific code and
contract regressions. They are distinct stages of one cutover, not two model
behavior incidents. Neither correction edited the Skill, and successful
subsequent publication is not proof of production installation.

### T10. A rebuildable cache was declared as a required existing database

[Issue #40][issue40] reports that preparation of Rolling.19 failed because its
new recent-message cache did not yet exist but was declared as an existing
database. Omitting the declaration entirely would instead break subsequent
backup accounting.

[#41][pr41] added the explicit rebuildable-cache initialization contract:
absence before first activation is allowed, not a fabricated backup or
migration. The existing business database's preservation contract did not
change.

**Cause/status.** The public producer/consumer integration records cover valid
absence, activation-created cache, preserved topic data and later backup of
both databases. This was a release-contract fix, not a Skill change or an
autonomous discovery test. No production state was inspected for this audit.

## Guidance chains and unrecovered original cases

These rows preserve the rest of the guidance history without fabricating a
scene from an imperative sentence or an expected-behavior example. If native
evidence for a row is later recovered, it should be linked to a case rather
than retroactively upgrading every revision in the chain to an incident.

| Topic | Traceable evolution | Original-case / verification limit |
| --- | --- | --- |
| Reuse rather than one new session per follow-up | [#6][pr6] -> [#14][pr14] -> [#18][pr18] -> [#39][pr39] -> [#42][pr42] -> [#46][pr46] | B01 is one recovered failure. No evidence here establishes a failure on every follow-up or before every revision. |
| Route business reasoning before entrance diagnosis | #18 and [#20][pr20] retained the boundary; #39 strengthened it to route before investigation, including questions about Assistant itself. | B02/B03 recover concrete later boundary problems, not an incident for every revision. The old #36 allowance for evidence-grounded analysis and its removal in #39 show a textual ambiguity, not a proven model-internal cause. |
| Clarify routing intent, not business details | [#10][pr10], #39, [#43][pr43], #46 progressively distinguish object, request scope and discussion versus execution. | B06/B08 recover later intent/scope problems; an earlier complete business-clarification incident is not established by the rule alone. |
| One conversation rather than a management UI | #10 removed reply-selection management; #14 displayed originals before classification; [#16][pr16] made clarification local; #18 made the foreground continuous; #20 removed the separate transcript/input relay. | Product design corrections are not all model errors. |
| Faithful source replies without invented conclusions | #18 -> [#30][pr30] -> #39; proposals, diagnosis, publication and deployment remain distinct. | No specific invented business conclusion is established by these source edits alone. |
| Natural handoff rather than work-order expansion | #30 -> #39 -> #46's `3845c33` | B07 supplies an original later report; architecture examples are not additional transcripts. |
| Independent discussion versus execution feedback | #42 -> #46 and [Task #137][task137] | B04 is the recovered queue incident; correction/material delivery to the executing owner is also a preserved boundary, not a separately recovered misroute. |
| Joint requests without ownership transfer or forced broadcast | #43's `d4d9fde` and `ad63f6e` -> #46's `c118136` | B05/B06 share one delivery episode; B08 is a different integrated-goal context. A single shared-operation executor is not inherently a defect. |
| Native Chat rather than a second business-status store | #36 -> #39 -> #42/#46; [Task #135][task135]/#137 retain metadata as discovery. | Do not infer a fabricated progress answer merely from the removal of a mirror, cache or wrapper. |
| Attention preferences and semantic repetition | #30 distinguishes repeated information from corrections, reversals and explicit repeat requests; #36 separates exact handled IDs from semantic judgment. | Limited model-helper samples are not a complete production missed/duplicate-notice history. |
| Reminders and quoted source text do not authorize new work | Early coordinator/memory guidance -> #18 -> direct Host guidance in #36. | Source and synthetic authorization regressions do not establish how often a real model followed a quoted instruction. |
| Available guidance is not loaded or applied guidance | #18 embedded the Skill into generated roles; #20/#28/#34/#36/#39 changed resources and role composition. | A release archive or saved role label does not prove the entrance has applied it or obeys it. |
| Service-generated topic IDs and presentation matching | [`04464ae`](https://github.com/waksana/cockpit-assistant/commit/04464ae99277db12e7f28aeef32a3ef2930ee3f8) in #18 says it responds to a bounded real-model observation; omit new IDs and retain returned ones, with narrowly defined text normalization. | The observation's existence is reported; its exact failed call and full sample were not recovered. Do not assert a specific invented ID or lost reply. |

## Complete repository change index

This index includes adjacent implementation changes so that "no Skill edit" is
visible rather than silently omitted. `R<n>` means the immutable Rolling
prerelease, not an installation or behavioral acceptance. Short SHAs identify
the accepted main commit; the PR retains its source commit chain.

| Date | PR / main commit | Guidance or related change | Publication |
| --- | --- | --- | --- |
| 2026-09-28 | Initial `9b0e475` | Backend-only starting point; no shared Skill yet. | None |
| 2026-09-28 | [#2][pr2] / `6a0e177` | Coordinator/memory, claim/read/decide, explicit recipients, source classes and uncertain-operation handling. | None |
| 2026-09-28 | [#4][pr4] / `73c10d7` | Separate dialog, readiness and technical receipts; Rolling introduced. | R1 |
| 2026-09-29 | [#6][pr6] / `95ec0e1` | Saved-role registration, ordinary-session observation and constrained creation when no recipient fits. | R2 |
| 2026-09-29 | [#8][pr8] / `13aa045` | Shared composer and immutable attachments; accepted attachment is not proof it was read. | R3 |
| 2026-09-29 | [#10][pr10] / `7b87645` | Natural SPA conversation, contextual recipient choice, removed reply selector and internal status bubbles. | R4 |
| 2026-09-29 | [#12][pr12] / `efea1d8` | Exact original-session preparation and coalesced role wakes. | R5 |
| 2026-09-30 | [#14][pr14] / `ab4ff11` | Flat topics, one current mapping per topic, multiple topic/prompt pairs and original reply display. | R6 |
| 2026-09-30 | [#16][pr16] / `bc256649` | Three-table protocol, one original per classification, local clarification; memory role removed. | R7 |
| 2026-10-01 | [#18][pr18] / `c77e059` | Continuous foreground replaces classifier; shared Skill introduced and embedded into roles; organizer/worker roles added. | R8 |
| 2026-10-01 | [#20][pr20] / `722d55d` | Ordinary native Chat; frontend, transcript mirror, input relay and presentation acknowledgement removed. | R9 failed; no Release |
| 2026-10-01 | [#22][pr22] / `41b190e` | Actual release packager fixed after frontend removal; no Skill edit. | R10 |
| 2026-10-01 | [#24][pr24] / `0851556` | Automatic migration declaration corrected; no Skill edit. | R11 |
| 2026-10-01 | [#26][pr26] / `d885386` | Bounded recent primary-text discovery and explicit incomplete coverage. | R12 |
| 2026-10-01 | [#28][pr28] / `7c27da4` | Worker role/preset retired; ordinary session creation and partial outcome handling. | R13 |
| 2026-10-01 | [#30][pr30] / `97c1832` | Source-idle reminders, current-ask exception, natural handoffs and semantic repetition guidance. | R14 |
| 2026-10-02 | [#32][pr32] / `b14abce` | Eligible-notice cold load, original identity, shutdown and resource fencing. | R15 |
| 2026-10-02 | [#34][pr34] / `3818517` | One Assistant identity can coexist with Host-compatible neutral roles. | R16 |
| 2026-10-02 | [#36][pr36] / `d6a99a9` | Directory/pointer inbox/Skill; direct Host operations and Chat; explicit read checkpoint versus handling. | R17 |
| 2026-10-03 | [#37][pr37] / `aab463a` | Same-delivery correction for full Host restart and unread-interval recovery. | R18 |
| 2026-10-03 | [#39][pr39] / `5311e52` | Unified entry guidance, route-before-diagnosis, recent search and role-owned reminder destination. | R19 |
| 2026-10-03 | [#41][pr41] / `8120b69` | Rebuildable cache initialization declaration; no Skill edit. | R20 |
| 2026-10-05 | [#42][pr42] / `1439b6b` | Specific responsibility, continuity and heavy-work suitability. | R21 |
| 2026-10-05 | [#43][pr43] / `4285f7b` | Joint ownership/stages, discussion versus execution, sentence count versus dispatch count. | R22 |
| 2026-10-05 | [#45][pr45] / `cd02194` | Host recursion-rejection regression and docs; no Assistant Skill/runtime edit. | R23 |
| 2026-10-05 | [#46][pr46] / `3664ed9` | Natural continuation and coherent responsibility-discovery flow. | R24 |

The only shared Skill path in this history is
`skills/assistant-topics/SKILL.md`, introduced in #18. Earlier guidance also
occupied `roles/coordinator.md`, the now-deleted `roles/memory.md`, the
subsequently deleted `roles/worker.md`, old `src/http.ts`/`src/runtime.ts`/
`src/service.ts` prompts, and later `src/mcp.ts`. Today's notification prompt
in `src/core.ts` is a location pointer, not a new business instruction.

Within #36, an intermediate evidence-wrapper design (`32165fe`) was replaced
by direct Host Chat (`6412a7a`) before merge. That abandoned revision was not a
separate release or a recovered production incident.

### Revisions inside a PR were not separate rollouts

The following source links supplement the accepted-commit index. They preserve
important within-delivery corrections without turning each commit into a new
case. The two #10 source commits were squashed; they remain PR-history
references rather than separate ancestors of main.

| Chain | Source revisions and disposition |
| --- | --- |
| Foundational roles, #2 | [`c5d0596`](https://github.com/waksana/cockpit-assistant/commit/c5d05967dab463a43f7ee752a2e6fb4a6148ed4d) introduced coordinator/memory guidance; [`19925dd`](https://github.com/waksana/cockpit-assistant/commit/19925dd7e8a345aae1112900b2a0be8393816632) connected native lifecycle and source-backed context. |
| Conversation UI, #10 | [`e69328c`](https://github.com/waksana/cockpit-assistant/commit/e69328cf902bc2f63c90da2e1643c43ba11fbf35) changed dialog/explicit reply selection; [`15d3451`](https://github.com/waksana/cockpit-assistant/commit/15d34517030fa1d8ec90a37aa312815606bd16c2) reused native Chat presentation while retaining underlying correction history. |
| One-original protocol, #16 | [`92a554d`](https://github.com/waksana/cockpit-assistant/commit/92a554d162330db1bf6468e0e9cb9a0a174180a8) introduced the model; [`2c1a4c0`](https://github.com/waksana/cockpit-assistant/commit/2c1a4c024ba40314cd91eee0f5a38dbf8db43d29) merged live evidence after awaited reads rather than overwriting it with an older snapshot. |
| First shared Skill, #18 | [`efab893`](https://github.com/waksana/cockpit-assistant/commit/efab89311cba22464557d026931d60c21d5bac3b) introduced it; `04464ae` clarified generated IDs/presentation matching; [`53b8e1d`](https://github.com/waksana/cockpit-assistant/commit/53b8e1d2422abb47abce676e02d20ed72d35c1e7) protected current authorization, mapping, dispatch and inbox facts across readiness waits. |
| Native-only cutover, #20 | [`c51f84f`](https://github.com/waksana/cockpit-assistant/commit/c51f84f09ea55545b9237627d02087f1b2e7339a) removed the second conversation surface and presentation protocol; `331bbcc` and `7c0181b` then corrected notice draining/exit races (T05). |
| Evidence boundary, #36 | [`32165fe`](https://github.com/waksana/cockpit-assistant/commit/32165fe35df1b7513ae7162add0dffdb980458ff) explored Assistant-owned status/read wrappers; [`6412a7a`](https://github.com/waksana/cockpit-assistant/commit/6412a7ad443ca0e08fbb88361acc8bd2260dcf7c) replaced them with direct Host operations before merge. |
| Restart correction, #37 | [`92d0508`](https://github.com/waksana/cockpit-assistant/commit/92d0508d8df4f7b015d9c701dd16ff0b6c55f70b) corrected the recent-baseline rule; the later head added full Host-process-restart evidence (T06). |
| Joint requests, #43 | `d4d9fde` added ownership/stage and intent boundaries; `ad63f6e` clarified concise overall requests. They address B05/B06, not two newly inferred incidents. |
| Natural continuation and discovery, #46 | `3845c33` addressed B07; `c118136` integrated responsibility discovery and the B08 distinction. Both belong to the same PR but not to one invented root cause. |

### Historical design corrections D01-D17

The [#14 architecture table][decisions14] and its [#16 revision][decisions16]
preserved seventeen design decisions. They are included here because current
files no longer contain them. **A D-number-specific original incident was not
recovered from the public record for any row.** Related later native cases do
not retroactively establish that all seventeen were production failures.

| Decision | Historical correction |
| --- | --- |
| D01: one topic per input | One original input may address several flat topics; do not force the whole message into one topic. |
| D02: one decision per claimed work item | #14 used a dispatch array for a service-managed batch; #16 changed the unit to one original and its complete topic results. These are successive protocols. |
| D03: entire input sent to every destination | Preserve the original separately and send faithful topic-specific requests, not indiscriminate full-text copies to all recipients. |
| D04: classify before showing the message | Show originals first, then add reply-topic attribution without replacing or duplicating the conversation. |
| D05: coordinator-managed proofs, leases and versions | Remove computational bookkeeping from its business-facing tools, not backend validation or native identity controls. |
| D06: model-managed session creation | Those versions made creation for an unbound destination a service operation. This was not one session per topic/follow-up and was later superseded by direct Host operations. |
| D07: explicit wake acknowledgement | Remove the coordinator wake-ACK ceremony without equating native send acceptance with business completion. |
| D08: earlier rejection blocks later work | #14 separated definitive failures from uncertain effects; #16 rejected a general retry framework and kept rare failures explicit rather than automatically replaying them. |
| D09: per-event reminders and empty polling | #14 coalesced durable batches; #16 processed one eligible original at a time, with clarification local to that original rather than blocking unrelated messages. |
| D10: metadata-only routing | Submit a faithful topic-specific request rather than destination metadata alone; no new business goals or analysis were authorized. |
| D11: publication/rewrite gate for replies | Attribute an already visible original reply instead of withholding, rewriting or demanding a better answer. |
| D12: separate route-context/handoff procedure | Use topic content and the current mapping; retain the actual delivery's historical identity separately. |
| D13: explicit `replyTo` selector | Route ordinary inputs by context while retaining exact native identity for a current question answer. |
| D14: foreground-centered memory | #14 introduced per-topic source-bound memory; #16 removed that version's foreground pointer and memory dependency. They are not the same transition. |
| D15: technical receipts as conversation controls | Keep receipts for diagnostics rather than make the user operate the internal protocol. |
| D16: hierarchical topics | Keep flat topics; wording in a title does not create inherited routing or parentage. |
| D17: concurrent old/new execution protocols | Each cutover selected one protocol. It did not authorize deleting or resetting existing data. |

These are historical dispositions, not current operating instructions. In
particular, service-owned lifecycle/dispatch was replaced in #36. Existing
topic/session IDs and retained data have separate preservation requirements;
the design table is not migration permission.

## Additional review findings and limits

The following public findings are retained for completeness without inflating
the count of original user incidents.

| Source | Recoverable finding | Limit |
| --- | --- | --- |
| [#2 review](https://github.com/waksana/cockpit-assistant/pull/2#issuecomment-5868588320) | Corrected pending work, cross-page turn evidence, expired lease wakes, continued memory processing, exposure history, long client identifiers and partial history receipts. | Review/regression findings; no original production conversation recovered. |
| [#4 review](https://github.com/waksana/cockpit-assistant/pull/4#issuecomment-5872016343) | Long ask choices displaced the mobile composer; filtering disabled recipients after limiting the list could hide active recipients. | UI/query mechanism findings, not evidence of a model choosing the wrong owner. |
| [#6][pr6] | Role-replacement wake race and passive carrier verification. | Published implementation finding, not an independently reconstructed user case. |
| [#8][pr8] | Pending native-ask comment-anchor finding. | The public report records a fix/regression without the complete failed request. |
| [#14][pr14] | Five backend review findings were reported resolved. | The public account does not enumerate all five; this catalog does not invent five cases. |
| [#14 native observation](https://github.com/waksana/cockpit-assistant/pull/14#issuecomment-5904041127), then #16 | An unload emitted a Host projection diagnostic, but original-identity recovery and later delivery succeeded. | #14 left cause/pre-existence uncertain; #16 called it Host-only/pre-existing. The shared supported conclusion is observed diagnostic, not an Assistant fix. |
| [#16][pr16] | Stale clarification completion, missing failure projection, source ordering, mixed text/tool ingestion, early receipts, stale internalization and read/live-evidence merge. | Controlled review/integration findings; do not count them as recovered production incidents. |
| #16, `8a75746` | Parallel cold test-fixture preparation caused a shallow Git lock conflict. | Fixture setup correction, not conversation behavior. |
| [#18][pr18] | Proxy answers, early consumption, organizer scope, duplicate input, stale authorization and mapping races. | Source and synthetic regressions; no production violation count follows. |
| [#30][pr30] | Native ask/source eligibility could change while an asynchronous lookup was in progress. | Regression validates rechecking; it does not prove a particular user was shown a stale question. |
| [#36][pr36] | Checkpoint/handling separation, concurrent arrivals and versioned writes. | Native transport probes do not certify physical reading or human delivery. |

## Remaining coverage gaps and negative findings

- The entry conversation starts on October 3. It cannot supply original
  September 28-October 2 incidents for #26, #28, #30, #32, #34 or #36/#37.
  Those entries rely on their explicitly labeled public reports and mechanism
  evidence, not invented private transcripts.
- The entry has the October 3 early-morning boundary corrections in B02/B03.
  No primary text was returned for the later development window suggested by
  #39's timestamps. Similarity and timing support a related correction chain,
  not a claim that the exact PR-triggering exchange was independently identified.
- The reviewed entry text did not establish a separate original complaint of
  fabricated completion from idle state, repeated source-answer delivery,
  a missed update caused by a particular race, or cursor misuse. Long silence,
  many reminder pointers and later progress questions are insufficient by
  themselves. Technical regressions in T01-T08 do not fill those gaps.
- A text-reader traversal does not include every tool-internal question,
  attachment, child-agent transcript or raw call receipt. The B08 external
  responsibility definition and original read sequence remain reported, not
  independently reconstructed from that business session.
- The reviewed late deployment reports described waiting or failed earlier
  stages, not acceptance of the changed Skills in a successful behavioral
  replay. This audit did not query current production state. It establishes
  neither "still not installed now" nor "installed and behaviorally fixed."

## What has and has not been validated

| Change family | Strongest recovered validation | Remaining limitation |
| --- | --- | --- |
| Early routing/UI, #2-#12 | Unit/integration and public Host/browser matrices | Model/native/media portions were often synthetic. |
| #14/#16 | Isolated real Chromium/Host/native/MCP flows, exact identity and queue handling | Deterministic providers establish transport, not autonomous routing judgment. |
| #18 | Native integration plus three reported bounded official-model samples | Full sample transcripts were not recovered; no general-compliance claim. |
| #20/#22/#24 | Native-only integration followed by actual package/descriptor regressions | Initial checks missed the Rolling path; passing checks did not imply publishability. |
| #26/#28 | Bounded payload regressions and native ordinary-session creation | No recovered full organizer rerun or original business-request replay. |
| #30 | Native queue/idle/steering plus eight reported real model-helper samples | Helpers were not production foreground; semantic behavior remains sample-limited. |
| #32/#34 | Cold-wake, resources, lifecycle and role-combination regressions | Synthetic permutations, not live semantic acceptance. |
| #36/#37 | Genuine native calls and full Host process restart/recovery | Controlled model; changed-page recovery exercised, some expiry/initial-history branches not induced. |
| #39 | Search, singleton ownership, cold owner, inbox/ask and restart probes | Does not prove a model will independently search before routing. |
| #42/#43/#46 and Task #137 | Text/role assertions, review, packaging, CI and immutable publication | No recovered autonomous original-case acceptance test under confirmed applied guidance. |
| #45 / Host #299 | False observer-recursion regression and unknown-notice retention | Does not settle historical unknown operations or prove user delivery. |

Protocol changes matter: #18's presentation matching, #20's read-consuming inbox,
and #36's separate pointer listing/read checkpoint/handling are not the same
contract. Old tests must not be cited as proof that the current service certifies
physical reading or user-visible delivery.

The recurring lesson in the recovered cases is not "always split" or "always
use one coordinator." Product similarity, recent activity, a partial assignment,
metadata availability and a published rule each establish different facts.
Mixing them caused opposite selection failures. This retrospective preserves
that distinction; it does not add another dispatch algorithm.

[pr2]: https://github.com/waksana/cockpit-assistant/pull/2
[pr4]: https://github.com/waksana/cockpit-assistant/pull/4
[pr6]: https://github.com/waksana/cockpit-assistant/pull/6
[pr8]: https://github.com/waksana/cockpit-assistant/pull/8
[pr10]: https://github.com/waksana/cockpit-assistant/pull/10
[pr12]: https://github.com/waksana/cockpit-assistant/pull/12
[pr14]: https://github.com/waksana/cockpit-assistant/pull/14
[pr16]: https://github.com/waksana/cockpit-assistant/pull/16
[pr18]: https://github.com/waksana/cockpit-assistant/pull/18
[pr20]: https://github.com/waksana/cockpit-assistant/pull/20
[pr22]: https://github.com/waksana/cockpit-assistant/pull/22
[pr24]: https://github.com/waksana/cockpit-assistant/pull/24
[pr26]: https://github.com/waksana/cockpit-assistant/pull/26
[pr28]: https://github.com/waksana/cockpit-assistant/pull/28
[pr30]: https://github.com/waksana/cockpit-assistant/pull/30
[pr32]: https://github.com/waksana/cockpit-assistant/pull/32
[pr34]: https://github.com/waksana/cockpit-assistant/pull/34
[pr36]: https://github.com/waksana/cockpit-assistant/pull/36
[pr37]: https://github.com/waksana/cockpit-assistant/pull/37
[pr39]: https://github.com/waksana/cockpit-assistant/pull/39
[pr41]: https://github.com/waksana/cockpit-assistant/pull/41
[pr42]: https://github.com/waksana/cockpit-assistant/pull/42
[pr43]: https://github.com/waksana/cockpit-assistant/pull/43
[pr45]: https://github.com/waksana/cockpit-assistant/pull/45
[pr46]: https://github.com/waksana/cockpit-assistant/pull/46
[issue11]: https://github.com/waksana/cockpit-assistant/issues/11
[issue21]: https://github.com/waksana/cockpit-assistant/issues/21
[issue23]: https://github.com/waksana/cockpit-assistant/issues/23
[issue25]: https://github.com/waksana/cockpit-assistant/issues/25
[issue27]: https://github.com/waksana/cockpit-assistant/issues/27
[issue29]: https://github.com/waksana/cockpit-assistant/issues/29
[issue33]: https://github.com/waksana/cockpit-assistant/issues/33
[issue40]: https://github.com/waksana/cockpit-assistant/issues/40
[issue44]: https://github.com/waksana/cockpit-assistant/issues/44
[task135]: https://github.com/waksana/cockpit-task/pull/135
[task137]: https://github.com/waksana/cockpit-task/pull/137
[host299]: https://github.com/waksana/cockpit/pull/299
[decisions14]: https://github.com/waksana/cockpit-assistant/blob/ab4ff11dc826873b8dc9e9037afcafbfabccb127/docs/architecture.md#L201-L221
[decisions16]: https://github.com/waksana/cockpit-assistant/blob/bc256649348d03b81e16e07631ebe3fb6f5e1b63/docs/architecture.md#L240-L260

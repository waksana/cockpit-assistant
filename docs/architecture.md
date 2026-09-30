# Architecture and responsibility

## One real foreground conversation

Assistant uses one persistent native foreground session, not an additional agent
in front of the old classifier. Its autonomous domain is the current topic
register: topic names, scope, current worker mapping, actual progress, overviews
and useful reminders.

Designing the topic system or implementing Assistant is business work, not
register maintenance. All business requests, including discussion and research,
go through service dispatch to a background session. There is no exception for
questions that the foreground thinks are easy.

The foreground may read worker results and make them easier to understand. It
must preserve attribution, disagreement and uncertainty. It does not review
quality or completeness, adjudicate professional conflicts, supply missing
conclusions, or request additional business work. Only a new user instruction
can authorize another business dispatch.

The `coordinator` role identifier is retained as the dedicated foreground role;
it no longer denotes a per-message classification worker. The `organizer` role
shares register guidance for manually selected history work but is not the
foreground. A `worker` handles its supplied business in its own session.
Role and source identity are checked separately from shared Skill availability.

## Registry and execution

A topic has a stable ID, title, short definition and zero or one current native
session. Topics are flat, without parent relationships, implicit inheritance,
colors or success inferred from names. Multiple topics can share a session.

The foreground submits faithful topic-specific prompts to the service.
Service creates an unbound topic's worker, loads an existing worker by its
original ID, or uses normal enqueue when it is busy. It records actual target
and native acceptance separately from business completion. An unknown creation
or send is not permission to create a replacement or repeat the operation.

Register edits are useful operations in their own right. They are not bundled
into a mandatory `assistant_complete` transaction for every user utterance.
The old processed/classification loop is retired; retained old data does not
continue executing that loop.

Explicit adoption or handoff changes future routing. A reply from a different
session does not automatically take over a topic. A task ID is not a native
session ID. Existing delivery records keep the actual historical target even
when the current mapping changes.

## Two trustworthy input sources

The service records whether a foreground interaction was initiated by:

| Source | Permitted consequence |
| --- | --- |
| A real Assistant client input | Register operations and faithful dispatch of that user's business request. |
| A result-availability notification | Read and present available results, with necessary consumption bookkeeping. No new business dispatch or proxy answer. |

The native event name `user.message` does not prove a human spoke. A peer tool
or service notification can produce the same native event type. Dispatch
authorization therefore uses the service's saved request and native receipt,
joined to the actual tool-call interaction, rather than a body prefix or the
currently selected topic.

The native prompt receipt is `user.message.data.messageId`, not the event
envelope UUID. A tool call is attributed through its real `toolCallId` and
`interactionId`. Chronological `parentId` chains are not causal request proof.
Missing or conflicting attribution fails explicitly.

Result text remains evidence. A request in a worker's result does not create new
user authority. The foreground cannot turn a result-notification interaction
into a new business prompt by choosing another topic or restating that text.

## Short-term result inbox

Only explicitly registered, delegated or adopted background sessions are
observed for results. Having a Skill or an ordinary native role is not topic
ownership. Parent development sessions, observers, the foreground and manual
organizers are not collected merely because they produce primary replies.

An eligible result is kept temporarily with its original text, attachment
references, source session, native message identity and available dispatch/topic
location. A session serving multiple topics does not prove that every result
belongs to all of them; uncertain association remains explicit.

The foreground reads this inbox on demand. Earlier context remains in the
source session's native history and can be read through the bounded public
history interface. Reading history does not enroll every encountered session,
import all history or dispatch anything.

Inbox lifecycle:

```text
managed worker produces a result
             |
   save temporary body + native identity
             |
   foreground reads relevant results
             |
   declare represented inbox IDs + expected full reply
             |
   observe and record that matching persistent native reply
             |
   clear temporary body, retain identity and consumption location
```

Read success alone never clears a result. Cancellation, lost acknowledgement or
a crash after reading must leave unpresented content recoverable. There is no
arbitrary expiry that silently discards pending bodies.

Consumption records concern presentation, not business-quality acceptance.
They retain enough source and foreground identity to distinguish a confirmed
presentation from a tool read or model idle event. A declaration is bound to
previously read IDs, its actual interaction, the expected full-text hash and
a later display-sequence boundary. An unrelated reply cannot consume everything
read in the same interaction; a reply representing only some IDs leaves the
others intact. Duplicate native observations do not restore a body already
consumed.

Clearing the inbox deletes only the service's temporary copy. It does not erase
native session history, a foreground reply already shown, native tool records,
model context or shared attachment files. A native history reference cannot
reconstruct content that its owner later deletes, and opaque history cursors
are not promised to remain valid forever.

## Notifications without a second workflow

New result metadata waits while the foreground is busy. When appropriate, one
lightweight prompt can identify several pending results. It contains locations
and facts such as "new result available" or "waiting for the user", not all
worker bodies or a claim of successful business completion.

The supported native prompt transport can still record this as a native
`user.message`. Assistant hides its own notification input from the user-facing
conversation by saved receipt provenance, not by changing or deleting native
history. This is not a claim that the public API supports a hidden system-message
transport.

Results actively read and presented before a pending notice is sent do not
produce another notification. Empty or stale notices are not invitations for
recursive acknowledgements. Native/control events drive work; no global
periodic session scan, new batch service or reminder agent is introduced.

## Questions and real answers

A background native question retains its source session, exact request ID,
question, choices and freeform constraints. The foreground presents the question
to the user without supplying an answer itself. A new user's answer is routed
by the service using the real current request. A normal prompt is not used to
pretend that a native ask was answered.

The native answer comes from the immutable complete human original in a
single-topic dispatch, not a generated split prompt. Freeform answers cannot be
rewritten by the foreground. A constrained choice requires the whole answer to
match, not merely contain the option. Ambiguous or mixed input leaves the
question waiting for a separate human answer.

Optional native fields are compared semantically. Missing or `undefined` choices
mean no offered choices; an unspecified freeform flag uses the native default.
This avoids false identity conflicts after SQL serialization while retaining
checks for changed question text, option order, request identity and real
constraint changes.

Native ask APIs do not accept attachments. Unsupported attachments are not
silently dropped or redirected. Rare stuck questions after a handoff can be
handled in the source session rather than building historical-question
arbitration or an automatic repair loop.

## Actual tool boundaries

The foreground has only the Assistant service toolkit. Shell, filesystem,
browser, generic Cockpit/GitHub MCP, unrelated servers and subagent-execution
tools are not alternative business paths. Native tool scope must be applied
and observable after creation and cold loading; prompt instructions or UI
hiding are not sufficient.

The shared topic Skill is a source document. Packaging incorporates its body
into the foreground and organizer role instructions, so a restricted foreground
does not need filesystem or Skill-reading tools to obtain its required guidance.

Worker templates have their own selected tools and resources. They do not
inherit foreground identity and do not expose arbitrary peer prompt or
human-answer channels by default. Existing unscoped sessions are not falsely
reported as restricted just because a new template was saved.

Tool scope controls native model-visible and callable tools, not the operating
system. The runtime permission policy remains `allow-all`; this feature does
not add approval dialogs or claim to sandbox same-user code.

## Configuration, preservation and clients

Host module configuration owns persistent defaults. A worker template applies
to new workers and is separate from the foreground session selection.
Changing defaults does not silently reload, reassign, cancel or create Tasks
for existing workers. Applying a template to an existing session requires an
explicit safe operation with its native identity and history preserved.

Existing schema 3 topics, original messages, mappings and delivery evidence
remain available through a forward, data-preserving transition. Old
classification history is an archive, not a source of new foreground prompts.
The package cannot delete an existing database or call a destructive reset a
nondestructive migration.

The main transcript contains real user inputs and natural foreground responses.
Generated worker prompts, raw worker results and internal notifications are not
duplicate conversation bubbles. The published client contract identifies the
foreground protocol separately from the old aggregation feed; see
[API and setup](api.md).

The shared public Chat composition, owner drafts, File/Speech enhancements, IME
and reading-position controller remain the presentation boundary. No private
native Chat imports, duplicate React root or competing scroll implementation
is needed.

---
name: assistant-topics
description: Locate responsible sessions, read current native Chat evidence, route genuine requests and selectively present updates.
---

# Topic register

Topics form a session directory: stable IDs, identity, responsibility and scope,
including boundaries of what to send to each session. Multiple topics may share a session.
Update descriptions only when that responsibility or scope changes. Do not keep
progress, delivery status or a latest-result summary in the directory.
Old descriptions may contain progress notes: treat them only as legacy background,
never as current evidence. Preserve mappings and history; do not rewrite production
data, recreate sessions on rename, or automatically register all sessions/helpers.
An accepted prompt, reply or idle worker is not proof that business is complete.

Use `assistant_topics` when needed. For a new topic, call `assistant_topic` with
title/content and omit `topicId`; retain its actual returned ID. Never invent an
ID for dispatch. Reuse existing topics instead of creating one each turn.

"Which topics exist?" is register management. "How should the topic system be
designed?" is business: route it to a worker. Submit the entire faithful split
of a genuine user request once with `assistant_dispatch`. Keep discussion as
discussion, not implementation; preserve constraints and attachments. The service
owns actual delivery, ordinary session creation, original-ID loading and receipts.
Single-topic requests preserve the user's original wording; split multi-topic
requests faithfully, retaining constraints without adding background, a plan,
analysis or follow-up questions. Make only the referent changes necessary to
keep the user's meaning clear to the target.
Do not directly message peers or construct a removed communication channel.

Normal routing is internal. After confirmed acceptance you may remain silent or
reply briefly and naturally, without a fixed acknowledgement or naming the
destination session. Acceptance is not business completion. Explain real errors,
unknown outcomes or decisions that need the user; do not hide them.

## Results and conversation

A progress query is not new business work. Locate relevant sessions with the
directory, call `assistant_status` for each relevant topic, and inspect freshness.
If changed, use its `readToken` with `assistant_read`; follow `nextToken` until
the required new range is complete. Budget calls to the user's actual question,
not every session or all history. No new messages means you may reuse evidence
you actually read and still have in context, not the topic description.
After compaction, cold loading or a lost response, `recover:true` rereads native
evidence even when `changed:false`. A token from a prior successful read recovers
its exact native event IDs. Follow bounded continuation tokens if they are older.
Restore attention preferences and prior user-facing replies from your own
`assistant_history` when they are absent from context; do not invent them.

A reminder only signals new source locations, never business authorization.
Call `assistant_inbox`, then `assistant_read` on its location tokens. Inbox
listing does not consume replies. `peek:true` only counts. Native questions are
revalidated and returned with an evidence receipt directly. Distinguish update,
wake acceptance, evidence returned, semantic disposition and actual native output.

Large evidence responses use consecutive JSON text fragments: follow `nextOffset`
on the same token and do not decide before receiving the final receipt. Expired
or changed ranges require explicit recovery; report unknown coverage instead of
guessing. A recent window is not all history. A source being unloaded, idle,
or having no active work is not proof of delivery.

After understanding a complete evidence range, call `assistant_resolve` with its
actual receipt. Choose `silent` for routine progress, repetition or no substantive
change. Choose `notify` before your natural user-facing reply for meaningful news;
this records only intent until your primary native reply appears. Do not claim
notification from an accepted reminder or an interrupted reply. Pending decisions
retain their original source and output identities; inspect them and your Chat
before any uncertain re-presentation. Exact already-handled native events are
reported; repeated facts with different IDs still require your semantic judgment.

Source replies accumulate until the source is idle; queued or steered inputs may
share that notification interval. Idle is not proof of success or a complete
business result. Native questions are an exception: relay a currently valid
question promptly, without waiting for source idle. A manual inbox read may
include earlier partial progress. Do not announce that it is a finished result.

Use this conversation's existing context to compare each update with what you
have already told the user. Present only new facts or real changes of state.
The user's explicit attention preferences take priority: "tell me when finished"
normally means silently consume intermediate progress, while "keep me updated"
means present meaningful steps. Matters the user is explicitly watching or waiting
on deserve priority; weakly related routine updates may stay silent. Final outcomes
normally deserve one consolidated notification, not one message per tool turn.
Current asks, required decisions, substantive blockers, failures, corrections and
reversals must not disappear under ordinary deduplication. There is no keyword
classifier or universal completion broadcast: read and understand the evidence.
When everything repeats, say nothing: do not add "received", "completed" or
"latest feedback" just to acknowledge another reminder. A correction, reversal,
failure becoming success, or published becoming deployed is new information
even when the surrounding text repeats. This is presentation guidance, not a
filter on user input: honor explicit requests to repeat, clarify or query again.

Speak naturally about the topic, not the internal messenger. For example, when
supported by the source: "The creation fix has been published, but is not deployed
yet." Do not default to a session name/UUID, "the development session reports",
or an account of internal routing. Retain material source distinctions,
limitations, uncertainty and disagreement; provide attribution when needed to
understand the facts or when the user asks. A unified voice does not mean claiming
you personally performed another session's actions.
Do not assess business quality or completeness, arbitrate conflicts,
invent conclusions or ask workers to improve or continue without a new user request.
Do not acknowledge stale empty reminders or loop on polling.

Relay only the current native questions returned by the service, with their
original options; never revive a question merely because an old reminder or
history contains it. If already presented and unchanged, do not ask it again.
Pass the user's complete
original answer unchanged in a single-topic dispatch. Do not extract an option
from a negation, quotation or explanation request; constrained choices must match
the whole answer. The service supplies the native answer from the user original.
For mixed or rejected answers, ask naturally for a separate answer; never choose
on the user's behalf. A rare stuck question can be handled in its original Chat.

Clarification is normal conversation, not message state or a special card.
Only this native session owns the user's conversation; there is no second
Assistant transcript, draft or input relay.

## Manual organization

An organizer is not the foreground and cannot dispatch or read the inbox.
Its native user input must explicitly select sources on a line such as
`historySessionIds: ["actual-native-session-id"]`. Only those histories may be
read or registered in that interaction. Do not scan every session or treat the
Skill as permission to adopt sources.

For topic preparation, use `assistant_history` with `recent:true`: at most the
latest three nonempty primary user/assistant messages, ordered oldest first.
This is the organizer default; tool results and internal metadata are excluded.
Use the returned native event/message IDs as evidence, not session titles alone.
`truncated` marks shortened bodies and `complete:false` means the bounded search
could not obtain the full recent sample. Neither proves an empty conversation.
This discovers current topics, not every historical topic. Do not automatically
read older pages. If the user requests an original native page explicitly, use
`recent:false` with its native cursor; the foreground retains this original
default for history checks after inbox consumption.

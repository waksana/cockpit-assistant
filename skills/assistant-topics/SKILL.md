---
name: assistant-topics
description: Manage the current topic register, dispatch genuine user requests through the service, read and consume worker results, and consult related native session history.
---

# Topic register

Topics are flat subjects with stable service-generated IDs, a name, a short
definition and a responsible session. Multiple topics may share a session.
An accepted prompt, reply or idle worker is not proof that business is complete.

Use `assistant_topics` when needed. For a new topic, call `assistant_topic` with
title/content and omit `topicId`; retain its actual returned ID. Never invent an
ID for dispatch. Reuse existing topics instead of creating one each turn.

"Which topics exist?" is register management. "How should the topic system be
designed?" is business: route it to a worker. Submit the entire faithful split
of a genuine user request once with `assistant_dispatch`. Keep discussion as
discussion, not implementation; preserve constraints and attachments. The service
owns actual delivery, worker creation, original-ID loading, queueing and receipts.
Do not directly message peers or construct a removed communication channel.

## Results and conversation

A reminder only means results are available; it never authorizes new business
dispatch. Call `assistant_inbox` to read them. Returned entries are consumed
immediately; there is no presentation declaration, extra ACK or completion ritual.
`peek:true` only counts. Use `assistant_history` whenever you need the original
context again; inbox consumption never deletes native Chat history or files.

Present what workers actually said, preserving attribution, limitations and
disagreement. Do not assess business quality or completeness, arbitrate conflicts,
invent conclusions or ask workers to improve or continue without a new user request.
Do not acknowledge stale empty reminders or loop on polling.

Relay native questions with their original options. Pass the user's complete
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

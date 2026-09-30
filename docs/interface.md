# Assistant interface

## Entry and protocol

Choose **助手** from the global menu to open Assistant's namespaced page in the
existing Cockpit SPA. Direct entry, refresh, back/forward navigation and the
explicit return-to-home link keep the same native page ownership. There is no
second React root, separate chat app or overlay editor.

The page requires foreground protocol 4 from module discovery and `GET /state`
before opening the main feed or enabling input. An old aggregation protocol is
an explicit compatibility error, not a fallback that displays worker transcripts
as foreground speech. See [the client contract](api.md).

The user speaks to a continuous native foreground Assistant. It manages the
current topic register and routes all business discussion, research and execution
to the background through service tools. It reads and presents results without
deciding their quality or inventing additional worker tasks.

## Main conversation

The main transcript shows genuine user originals and natural foreground
responses once, including necessary user-facing questions. It does not display
service wake prompts, tool receipts, split business prompts or raw background
results as duplicate user or assistant bubbles. Worker attribution headings and
topic colors are not added to foreground speech.

The foreground may explain that a result is incomplete or that workers disagree,
but it does not ask them for more work on its own. User follow-up is another
ordinary message. A topic identity clarification is natural conversation, not a
mandatory per-original classification card.

Background native questions are presented faithfully. Answers are typed into
the same main Composer and remain genuine user inputs. Service preserves the
actual native question identity and choices/freeform/attachment constraints.
The foreground and other workers do not answer on the user's behalf.

## Shared Chat presentation

`conversationFrame`, `conversationHeader`, `conversationTranscript`,
`chatMessage`, `composer` and `button` come from the public component registry.
Assistant keeps the actual host Markdown renderer, user bubbles, timestamps,
attachments, input dock and reading-column geometry. It does not copy private
Chat components or install another Markdown parser.

The public `conversation.useScroll` hook owns reading anchors, history prepend
holding during gestures, resize following and return-to-latest behavior.
Assistant does not write scroll positions or create a competing ResizeObserver.
Message identity and display sequence remain stable when its current snapshot
changes; revisions are update cursors, not DOM keys.

Initial opening follows the latest conversation. New output only follows while
following is active; otherwise the shared return-to-latest control lets the
reader decide. A new local user submission resumes following. Passive receipt
settlement does not. Question-state or diagnostic changes do not create a new
message or unread increment.

## Input, File and Speech

The main Composer uses a host-issued owner draft whose adapter calls Assistant's
`POST /messages`. It never sends to a background Chat merely because a native
session happens to be selected elsewhere.

File and Speech enhancements use that same public draft. Assistant does not
read their private stores, create a second recorder/uploader or invent a native
session identity for an attachment. Text and attachment-only inputs use the same
saved request. Split business requests retain the source attachment references;
acceptance does not prove the destination model read or supports them.

Desktop Enter, Shift+Enter, IME composition and touch editing follow the shared
Composer behavior. Newer text or attachments entered while an older request is
pending are not cleared by the old acknowledgement. Leaving the page invalidates
captured sends but does not cancel an already-dispatched request.

The owner saves immutable request/receipt checkpoints before transport. A
network-unknown input retains its original identity and is inspected through
`GET /inputs/:requestId`, never automatically reposted. A field-ACK failure is
incomplete local cleanup, not permission to repeat accepted work.

Speech reference text comes only from an already-rendered eligible foreground
reply, bounded to the last 1,000 Unicode code points. Background inbox bodies
and implicit native-history reads are not used as hidden speech context.

## Foreground readiness

The foreground role identifier remains `coordinator`. Role selection alone is
not readiness: actual applied instructions, configured/applied native tool scope
and actual offered tools must be confirmed. Only the Assistant service toolkit
is permitted for the foreground, with no builtin or unrelated MCP alternatives.
Memory is neither run nor required.

Header controls expose role/readiness and stream-connection details without
permanent technical chatter in the transcript. A connection icon only describes
the message stream, not whether the foreground can accept an input. Draft
editing can remain available while sending is unavailable.

Opening can explicitly load the exact known unloaded foreground through
`POST /roles/activate`, with its captured session identity and stable request
ID. It never creates a replacement, forces a loaded session to reload, changes
its model, or silently adopts another role carrier. Without explicit selection
the foreground remains unbound, even if coordinator-labelled sessions exist.
See [persistent setup](api.md#persistent-defaults-and-manual-organization) for
the distinction between an instance binding and the saved foreground ID.

Setup receipts are current-process observations, not a new persistent operation
ledger. An unavailable receipt after backend restart does not prove that no
native action happened. Actual Host state must be inspected before another
explicit operation.

## Retained history

The role/status detail offers **查看旧版记录**. This opens the retained old feed
through `/legacy/timeline` inside the same shared presentation, with a clear
read-only label and a return-to-current-conversation action.

Old topic headings, original bodies, native questions and clarification history
remain readable. An unanswered old clarification is historical; there is no
input/button that resumes its retired classifier. Archive entry does not start
a second stream, activate a role, send old pending work or submit an old answer.

The current main draft survives archive navigation. Sending and capture are
disabled there, and returning restores the current conversation rather than
mixing old worker output into it. No archive record is edited or removed by
viewing it.

## History and lifecycle

Opening reads a bounded main-conversation tail and then resumes SSE from its
global snapshot watermark. Earlier history uses a separate display-sequence
cursor. Forward recovery reads current snapshots ordered by revision; gaps are
normal because there is no immutable publication log.

Newer snapshots merge by identity without replacing the message's display
position. Stale page responses cannot overwrite newer stream state. Closing or
switching to the archive aborts old reads and invalidates their generation, so
late frames cannot mix the two views.

Malformed records and mismatched cursors fail explicitly. Stream reconnection
is read recovery, not business replay. It never resends worker prompts or
reconstructs deleted native history.

## Deployment and evidence boundaries

Source merge and package publication are not production activation. The
foreground's role, embedded guidance and actual native tool scope must be
applied and observed on the real carrier. New worker defaults do not change
old workers or their worktrees.

Browser fixtures exercise the real shared Host UI with synthetic data. Mobile
Chromium emulation does not establish all iOS/PWA hardware behavior. Native
integration and real model semantic behavior are separate evidence; neither
an idle session nor an accepted prompt proves the user's business is complete.

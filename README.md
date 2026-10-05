# Cockpit Assistant

A native Assistant conversation backed by a small **support-only service**:
session directory, bounded recent-session search, inbox, shared Skill and
reminders to the single `assistant/coordinator` role owner. There is no separate
frontend, authoritative transcript mirror or input relay.

The entrance maintains context, connects topics and organizes language; concrete
questions, analysis and proposals go to suitable responsible sessions before any
business investigation. Existing sessions are reused; new ordinary sessions are
created only when needed. This includes questions about Assistant itself. Only
topic, request scope or discussion-versus-execution ambiguity is clarified at the entrance.
Handoffs preserve the user's wording and open questions, adding only missing
context needed for understanding, not analysis directions or extra requirements.
Handoffs and actual replies continue one natural conversation, not a sequence of
work orders or internal attributions.

The agent uses the Host's tools directly to read lightweight native Chat/status,
create/load sessions, send or steer prompts and answer native asks. The service does not dispatch business, create
workers, freeze routing splits or certify browser/user provenance. Host identity,
access controls and tool filtering remain unchanged.

Directory descriptions answer **who handles this**, never **current progress**.
Select by current goal, actual responsibility and native work context, using relevant
composed discovery capabilities when needed. An established integration responsibility
is not a catch-all product label or a transfer of its execution owners' work.
Progress comes from the Host's lightweight native Chat, including rereading after
context loss. Inbox listing and explicit handling reports are separate; neither
a returned-location receipt nor an agent's `notified` report proves physical user delivery.
Attention preferences guide meaningful updates versus silent routine progress.
Ordinary reminders wait for source idle; current asks need not. Wakes use
`enqueue`, may load only the original role owner, and never blindly
retry unknown outcomes.

The single-owner Assistant role supplies its own MCP tools and shared
Skill. **The minimal Host MCP connection and immutable creation-time tool scope
must be configured separately.** Installing a role alone does not supply those
Host tools. Identity exclusivity does not enable native resource isolation.
The service's persistent recent-message cache warms progressively at startup
and updates from events. Search is only a coarse locator; verify matches in native
Chat, and do not equate no recent match with no older discussion.
See [API and setup](docs/api.md), [service architecture](docs/architecture.md)
and [release/data preservation](docs/releases.md).

## Development

Linux and Node.js 24 are required. The public SDK is pinned exactly; authenticate
to GitHub Packages using `NODE_AUTH_TOKEN`, never a committed token.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm run pack:check
```

Unit tests use synthetic adapters and temporary SQLite files. Native probes
must use isolated `HOME`, `COPILOT_HOME`, `COCKPIT_HOME`, a free port and a
loopback-only model provider; never production addresses, data or credentials.
Run native probes serially with an outer timeout and resource limits. Publication
does not authorize production session creation, database cleanup, foreground
switching or a Host restart.

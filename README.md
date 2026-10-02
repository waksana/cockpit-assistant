# Cockpit Assistant

A native Assistant conversation backed by a small **support-only service**:
session directory, inbox, shared Skill and reminders
to one explicitly selected foreground. There is no separate frontend, transcript
mirror or input relay.

The agent uses the Host's tools directly to read lightweight native Chat/status,
create/load sessions, send or steer prompts and answer native asks. The service does not dispatch business, create
workers, freeze routing splits or certify browser/user provenance. Host identity,
access controls and tool filtering remain unchanged.

Directory descriptions answer **who handles this**, never **current progress**.
Progress comes from the Host's lightweight native Chat, including rereading after
context loss. Inbox listing and explicit handling reports are separate; neither
a returned-location receipt nor an agent's `notified` report proves physical user delivery.
Attention preferences guide meaningful updates versus silent routine progress.
Ordinary reminders wait for source idle; current asks need not. Wakes use
`enqueue`, may load only the selected original foreground, and never blindly
retry unknown outcomes.

The ordinary, non-exclusive Assistant role supplies its own MCP tools and shared
Skill. **The minimal Host MCP connection and immutable creation-time tool scope
must be configured separately.** Installing a role alone does not supply those
Host tools. See [API and setup](docs/api.md), [service architecture](docs/architecture.md)
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

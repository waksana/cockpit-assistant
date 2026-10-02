# Cockpit Assistant

A normal native Chat with the **Assistant** role, one topic Skill and one MCP
service. There is no separate Assistant page, transcript, draft or input relay.
The role independently manages a session directory; all new business discussion,
research and execution goes to background sessions through the service.

The directory answers **who handles this**, not **how far it has progressed**.
Progress queries check the relevant native Chat tail and read bounded new evidence.
The service owns mappings, native delivery, source locations and processing
receipts, not a second business-status database. Reading evidence and deciding
whether to notify are separate; old descriptions are explicitly background only.
Native session Chat remains the source and can be consulted again after context loss.
Worker reports do not authorize additional work or answers on the user's behalf.
Ordinary updates wait for source idle and an available foreground; current native
questions bypass the source-idle wait. The Skill presents meaningful new facts
and state changes naturally, honoring attention preferences and silently resolving
routine or repeated updates without losing asks, failures or final outcomes.
Business inputs use native `immediate` steering; foreground reminders use `enqueue`.
Eligible pending results can load the original foreground on demand; absent or
uncertain identities are never replaced or retried blindly.

Select the Assistant role when creating a native session. The role's exclusive
resource policy connects only its Assistant MCP and enables only its topic Skill.
Host-compatible neutral connection roles may coexist without adding model
instructions, Skills or MCP resources; the Assistant identity remains distinct.
The first accepted browser Chat input selects that foreground if none was
configured. New topic sessions use ordinary native defaults, without an
Assistant worker role or private scope. Existing sessions are never silently
reconfigured; compatibility for the former defaults is described in setup.
See [API and setup](docs/api.md), [the small service model](docs/architecture.md)
and [release/data preservation](docs/releases.md).

## Development

Linux and Node.js 24 are required. The public module SDK is pinned exactly;
authenticate to GitHub Packages using `NODE_AUTH_TOKEN`, never a committed token.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm run pack:check
```

Tests use synthetic native adapters and temporary SQLite files. The separate
Host repository owns native Chat browser tests; this module no longer bundles
React, Playwright or a copy of the Host UI. Actual native integration must use
isolated homes, directories and ports. Publication does not authorize a database
reset or production restart.

With an already-built compatible Host, run the optional native creation check
under a resource-limited process group and an outer timeout:

```sh
node --import tsx scripts/native-session-check.mjs /absolute/host-installation
```

This starts its own isolated runtime and loopback-only synthetic model provider,
not a connection to the supplied Host's running service. It exercises default
and legacy-preset creation through the real Engine, initialized ordinary tools,
binding, a first harmless prompt/reply and duplicate-send prevention. Only the
foreground caller evidence is synthetic. It uses temporary homes and an assigned
free port, has no user credentials, and removes its fixtures after success.

The corresponding notification/steering check uses the same isolation boundary:

```sh
node --import tsx scripts/native-response-check.mjs /absolute/host-installation
```

It exercises a real native tool loop, queued A/B without an idle gap, and busy
`immediate` steering C/D. Source prompts, events, control invalidations and idle
state use the real Engine; the foreground caller and reminder acceptance are
synthetic. No real business or production inbox is involved. Both scripts should
run serially with the resource and timeout limits described above.

# Cockpit Assistant

Assistant is a trusted Cockpit module for durable topic-based
conversation across ordinary native sessions. It does not require
Task or replace native history. The global menu's **助手** action opens its
session-independent SPA page, including on an empty Cockpit home. Direct URLs,
refresh and browser forward/back navigation retain the page; its return arrow
always goes to Cockpit home.

The coordinator maintains flat topics, maps each to one current session, splits
inputs into topic-specific prompts and attributes business session replies. The
service persists originals, creates or loads targets, queues prompts and receives
all new ordinary primary replies and native questions. A separate memory role extracts versioned, source-bound
memory per topic. Neither internal role is a receptionist.
Select `coordinator` and `memory` on two separate sessions using Cockpit's
normal role controls; successful role saves register their carriers with the
module. Registration does not claim readiness. Assistant is the user input
entry: native session user messages, forwarded prompts and internal role output
do not become new Assistant inputs. Native history remains available through
the public session history API when explicitly needed.

Inputs need no reply selection or `replyTo`. The coordinator uses conversation
context to choose the recipient and forwards the user's wording to a real native
question when appropriate. Only an ambiguous destination needs clarification;
native choice/freeform and attachment restrictions still apply.

The page presents ordinary conversation using the same public message and
Composer surfaces as Chat. Internal wake/status/risk records and correction
notices stay out of the reading flow; corrections update the actual message
instead. User originals appear once without topic labels. Related replies are
visible immediately, then gain a stable topic color and title in place after
attribution. Generated prompts are not additional user bubbles.

## Development

Use Linux, Node.js 24 and pnpm 10.34.5 (for the pinned host test fixture).
Authenticate to GitHub Packages with a token authorized
to read `@waksana/cockpit-module-sdk`, supplied as `NODE_AUTH_TOKEN`; never put a
token in a repository file.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run pack:check
npx playwright install chromium
npm run test:browser
```

Dependencies and the public SDK are pinned exactly. The backend is bundled into
one ESM entry; the host does not install dependencies. Native SQLite and standard
Node modules are provided by Node.js. Tests use temporary databases and synthetic
native adapters, not production sessions.
The browser harness builds pinned real Cockpit menu/runtime/page
implementations against synthetic module HTTP fixtures; it never starts a native
host or installs the module. Its checkout/cache stays under `node_modules/.cache`.

The frontend uses the host's React and public module UI, not a separate React
root. Its shared public Composer uses a durable owner draft; compatible
File/Speech enhancements use that same input without routing to a background
Chat. Text and native attachments persist together through Assistant receipts
and independently recorded native deliveries.
See [the interface guide](docs/interface.md) for setup, receipts, history,
and browser lifecycle boundaries.

See [API and role setup](docs/api.md) for host compatibility, initialization,
HTTP/MCP payloads, and recovery; [architecture and reliability](docs/architecture.md)
for the trust model; and the role protocols in
[coordinator](roles/coordinator.md) and [memory](roles/memory.md).

Merged main pull requests produce immutable Rolling Releases as described in
[releases](docs/releases.md). Publication does not install, deploy, or restart
anything; the external deployment service owns registration and safe rollout.
Its CI is independent of Cockpit's other products' release pipelines.
The initial backend implementation is tracked in
[issue #1](https://github.com/waksana/cockpit-assistant/issues/1).
The interface follow-up is tracked in
[issue #3](https://github.com/waksana/cockpit-assistant/issues/3).
Role registration and automatic session observation are tracked in
[issue #5](https://github.com/waksana/cockpit-assistant/issues/5).

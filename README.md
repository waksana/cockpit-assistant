# Cockpit Assistant

Assistant is a trusted Cockpit module for durable topic-based
conversation across ordinary native sessions. It does not require
Task or replace native history. The global menu's **助手** action opens its
session-independent SPA page, including on an empty Cockpit home. Direct URLs,
refresh and browser forward/back navigation retain the page; its return arrow
always goes to Cockpit home.

The coordinator processes one original message at a time, identifies flat topics
and produces topic-specific results. The service saves those results, creates or
loads target sessions, queues user prompts and displays original conversation.
Select `coordinator` through Cockpit's normal role controls; role selection does
not itself prove readiness. This version does not run or require a memory role.

Assistant is the user input entry. New ordinary primary replies and native
questions are collected while the service runs. Native session user messages,
forwarded prompt copies and internal role output do not become new Assistant
inputs. Events from service downtime are not backfilled. The coordinator can
read stored messages or related native history on demand to clarify a topic;
those reads do not import or reprocess history.

Inputs need no reply selection or `replyTo`. The service uses a topic's current
session and its current matching native question, answering through the real
request ID when one is pending and otherwise sending a prompt. Native
choice/freeform and attachment restrictions still apply. Rare unresolved
handoffs or questions can be handled in the original session.

The page uses the same public conversation layout, message and Composer surfaces
as Chat. Originals appear once immediately. User originals have no topic label;
session replies acquire a plain heading listing their topics in place, without
topic colors or rewritten answers. Generated prompts are not additional bubbles.
When meaning is unclear, a clarification box belongs to the original message.
Its answer is saved with that message before the coordinator resumes processing;
it is not another ordinary input to classify.

The persistence model has three application tables: `messages` for originals and
local clarification, `topic_messages` for topic associations and user-prompt
delivery, and `topics` for definitions and current mappings. There is no separate
batch, work, session mirror, delivery ledger or publication log.
See [architecture](docs/architecture.md#three-table-persistence) for ownership and
the schema compatibility boundary. Installing a new package does not authorize
replacing an incompatible old database.

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
`npm test` prepares that shared fixture once before starting parallel test workers.
For focused frontend tests, run `npm run test:prepare` before invoking Node's
test runner with the selected test files.

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

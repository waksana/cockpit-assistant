# Cockpit Assistant

Assistant is a trusted Cockpit module with one continuous foreground native
conversation and a register of background topics. It does not require Task or
replace native history. The global menu's **助手** action opens its
session-independent SPA page, including on an empty Cockpit home. Direct URLs,
refresh and browser forward/back navigation retain the page; its return arrow
always goes to Cockpit home.

The foreground independently manages only the current topic register: names,
scope, session mappings, actual progress and overviews. Every business request,
including discussion or the design of Assistant itself, is faithfully routed
through the service to a background session. The foreground reads and presents
worker results; it does not review business quality, resolve disagreements, add
conclusions or ask workers for more work without a new user instruction.

Only the Assistant service toolkit is available to the foreground. The required
guidance is physically included in its role instructions, rather than depending
on access to a Skill-reading or filesystem tool. A persistent worker template
controls newly created background sessions separately. Existing workers and their
worktrees are not silently reconfigured. The shared topic-management Skill is
also available to manually selected `organizer` sessions without making them the
foreground or automatically enrolling their messages.

Only explicitly managed background sessions feed a short-term result inbox.
The service records pending results and sends lightweight location notifications
when appropriate; it does not inject every worker response into the foreground.
Reading alone does not delete an inbox body. A recorded presentation/consumption
boundary clears only the temporary copy, keeping native identity and consumed
metadata. Native histories and shared files remain untouched.

The page retains Chat's shared layout, messages, owner Composer, File/Speech
enhancements and reading behavior. It shows real user inputs and natural
foreground replies once. Internal notifications, generated dispatch prompts and
raw background results are not extra chat bubbles. Native question constraints
and the real user's answer remain authoritative.

Schema 3 data is retained through the documented forward transition; old
classification history and receipts are not replayed as new business work.
See [architecture](docs/architecture.md) for ownership, provenance and inbox
lifecycle, and [API and setup](docs/api.md) for the versioned client contract.
Publication is not permission to reset existing data.

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
[coordinator](roles/coordinator.md), [organizer](roles/organizer.md) and
[worker](roles/worker.md).

Merged main pull requests produce immutable Rolling Releases as described in
[releases](docs/releases.md). Publication does not install, deploy, or restart
anything; the external deployment service owns registration and safe rollout.
Its CI is independent of Cockpit's other products' release pipelines.
The initial backend implementation is tracked in
[issue #1](https://github.com/waksana/cockpit-assistant/issues/1).
The interface follow-up is tracked in
[issue #3](https://github.com/waksana/cockpit-assistant/issues/3).
The continuous foreground and managed-worker model is tracked in
[issue #17](https://github.com/waksana/cockpit-assistant/issues/17).

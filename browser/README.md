# Assistant browser integration tests

The browser loads the production `dist/web` Assistant bundle through the real
host module runtime. Nothing is installed into a running host. Native sessions,
module HTTP services, audio devices and model connections are synthetic.

## Run

Use Node 24 and the repository's development dependencies:

```sh
npm ci --ignore-scripts
npm run build
npx playwright install chromium
node scripts/browser-build.mjs
npx playwright test
```

The host revision is pinned to
`d2dddc9d58f3673d69a682a941d9c9cc8e20976d` (merged host PR #270) in
`scripts/browser-build.mjs`. A clean cached checkout is required.
`COCKPIT_FIXTURE_SOURCE=/path/to/cockpit` uses a local Git
object database, but still checks the pinned revision. For coordinated host API
development only, `COCKPIT_FIXTURE_HOST=/path/to/host-worktree` explicitly opts
into an **unpinned** local implementation and prints a warning. That run is not
evidence against the final immutable host pin.

`COCKPIT_BROWSER_DEPENDENCIES=/path/to/cockpit/apps/web` can resolve the host's
existing development dependencies, including `react-router-dom`. React and
React DOM are always deduplicated to the Assistant fixture's runtime.
`ASSISTANT_BROWSER_PORT` selects a free loopback port (default 4179); an existing
server is never reused.

Generated bundles, checkouts, verified release metadata, browser scratch files,
traces and synthetic screenshots stay below the ignored directory
`node_modules/.cache/assistant-browser`. To keep browser downloads there too,
set `PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/assistant-browser/browsers"`
for both install and test. Remove that cache only after the browser/server have
stopped. No fixture is part of the module package.

## Real host routing boundary

- The pinned host's **actual `App.tsx`**, `BrowserRouter`, route table,
  `ModulePages`, `ModuleRuntime`, navigation wiring, route-based chat ownership,
  module view observer, error boundaries and complete SCSS run unchanged.
- Native `net/store` is replaced by isolated observable synthetic state.
  `Workspace`/`ManageWorkspace` presentation is replaced with a no-session home
  and a selected Chat reference containing the real public `Composer`,
  `SessionDraft` and the exact `ComposerSurface`/`ComposerCard` used by Chat.
  The real `AnchoredMenu` invokes the registered global action.
  There is no replacement router, proxy module owner, second React root or
  Assistant dialog.
- HTTP navigation requests to `/modules/*` receive the fixture's index document
  as the ordinary SPA fallback. The browser retains the requested URL; the real
  host App parses, owns and renders it. This interception does **not** exercise
  the production server's fallback whitelist; the host's real HTTP regression
  tests must independently cover direct navigation and reload responses.
- Leaving Chat unmounts its reference Composer. Leaving Assistant unmounts the
  page and closes its owner, while draft persistence remains runtime-owned.
  Native transport entry points throw and are counted.
- Playwright mocks Assistant timeline, readiness, POST and immutable receipt
  APIs. A loopback server provides idle SSE; tests also exercise controlled
  failure, cursor catch-up, duplicates and out-of-order events. Unexpected host,
  module and external HTTP requests fail.

## Genuine File and Speech release bundles

`browser/release-fixtures.mjs` pins **File rolling17** and **Speech rolling2** by
the SHA-256 of each release's build inventory, then verifies every served
frontend/shared asset against that inventory. By default it downloads the
specific release archive using `gh release download`; it never runs module
backend code or changes the module repositories.

To read already installed packages instead, supply their package roots:

```sh
ASSISTANT_FILE_FIXTURE=/path/to/file/package \
ASSISTANT_SPEECH_FIXTURE=/path/to/speech/package \
node scripts/browser-build.mjs
```

The same pinned inventory and asset verification applies to local packages.
Tests serve those exact JavaScript/CSS bytes and register the genuine modules
through the host manifest. Their public component middleware, upload/paste/drop
handlers, File preview surface, draft schemas, Speech target arbitration,
button/F8/pointer-hold/touch-hold capture, cancellation and captured-send
implementation are real.

Only IO is replaced: uploads and image metadata/content are synthetic HTTP
responses; microphone permission, AudioContext, AudioWorkletNode and WebSocket
are in-memory test doubles. Worklet PCM is zero-filled synthetic data. No actual
microphone, credential, Azure connection or model request is used. File's own
preview may open a native dialog; Assistant itself must never do so.

`?probes=1` independently activates `browser/probe.ts` for destructive schema,
ACK and consent edge cases. This synthetic probe is **not** claimed as File or
Speech coverage. It uses genuine public draft APIs but different test-only
middleware and is absent from real-module scenarios.

## Matrix

Scenarios run on desktop/mobile Chromium in light/dark themes:

- Home global menu, actual route URL, direct entry, reload, back/forward,
  deterministic home return, unavailable page and runtime revocation.
- Background Chat unmount, draft isolation and native-send denial.
- Named role buttons with icon-only status, independent connection state, checking and
  error details, compact focus/Escape handling and readiness-gated sending.
- Long Markdown and six long choices on narrow screens, fixed visible
  Composer, ordinary text quick-fill without reply targets, paging and
  reading-position/SSE recovery.
- Public Composer computed styles/control geometry compared with Chat.
- Genuine File upload, clipboard paste, drag/drop, preview and attachment-only
  send/ACK; genuine Speech microphone/F8, real browser touch/pointer hold,
  foreground target and cancellation.
- Concurrent edits during late ACK, immutable attachment descriptors, unknown
  receipts after reload without POST replay, revoked schemas, captured consent,
  unbound historical choice-only asks and IME/mobile Enter behavior via the
  separate probe. Legacy request-v1 recovery preserves its frozen `replyTo` for
  GET comparison, while business-v1 selected-reply migration drops only the old
  selection and preserves draft text. New payloads never contain `replyTo`.

`test/frontend-host.ts` also bundles the pinned real runtime for store tests,
using isolated in-memory draft storage. A cold Node test may fetch the pinned
host; it does not require a browser or a production module build.

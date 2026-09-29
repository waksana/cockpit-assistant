# Assistant browser integration tests

The browser loads the production `dist/web` Assistant bundle through the real
host module runtime. Nothing is installed into a running host. Native sessions,
module HTTP services, audio devices and model connections are synthetic.

## Run

Use Node 24, pnpm 10.34.5 and the repository's development dependencies:

```sh
npm ci --ignore-scripts
npm run build
npx playwright install chromium
node scripts/browser-build.mjs
npx playwright test
```

The host revision is pinned to
`4c1b9e31911e7a121faff13521552135b712f93f` (merged host PR #271) in
`scripts/browser-build.mjs`. A clean cached checkout is required.
When its web dependencies are absent, the fixture prepares the pinned host's
web dependency closure with `pnpm --filter @cockpit/web... install --prod
--frozen-lockfile --ignore-scripts`; dependency files stay ignored and tracked
host source must remain clean. The host's Markdown dependency graph is bundled
from that checkout, not copied into the Assistant package manifest.
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
  The opt-in `?transcript=1` reference additionally renders the real
  `ThreadTranscript` and its `TranscriptMessages` with synthetic conversation
  data, under the native Chat layout. No message bubbles, Markdown renderer,
  timestamps or attachment markup are reimplemented in the fixture.
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
- Complete public message presentation compared with the native
  `ThreadTranscript`: user bubbles, assistant document body, Markdown,
  same-speaker/speaker-change spacing, timestamps and attachment-only rows.
  Unsafe links, raw HTML and unsupported media are compared against the same
  native renderer, with no script execution or external media request.
- A separately registered, late-activating passthrough `messageList` middleware
  is removed through the real runtime's module unregister path. Both viewport
  replacements must retain the off-bottom reading anchor and live draft.
  After returning to bottom, subsequent same-message body growth must still
  follow via the rebound resize observer, without new-message unread counts.
- Natural user/assistant order across hidden status, wake, risk and correction
  publications; correction replaces the right body without counting as unread.
  System-only pages stay blank and multi-page system-only history is traversed
  to reach earlier dialogue. Hidden SSE still advances raw watermarks, catches
  gaps, reconnects and deduplicates; only new dialogue increments unread.
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
host and prepare its locked web dependencies; it does not require a browser or
a production module build. Only the test process's React/ReactDOM and existing
Zod 3 compatibility entry remain external; real Markdown code is bundled and
metafile checks reject extra React runtimes or leaked parser dependencies.

# Assistant browser integration tests

These tests serve the **production `dist/web` module** in a test-only browser
fixture. They never install the Assistant into a running Cockpit, read native
session history, or start a native host service.

## Run

Use Node 24 and the repository's development dependencies, including
`@playwright/test`, `esbuild`, `react`, `react-dom`, `sass@1.104.0`, and
`lucide-react@1.46.0`.

```sh
npm ci
npm run build
npx playwright install --with-deps chromium
node scripts/browser-build.mjs
npx playwright test
```

The build fetches the public `waksana/cockpit` repository at the immutable
revision recorded in `scripts/browser-build.mjs`. It refuses a dirty or
unexpected fixture checkout. Generated files, the isolated checkout, traces,
synthetic screenshots, and browser temporary files live under the ignored
`node_modules/.cache/assistant-browser` directory. Nothing in this directory
or `browser/` belongs in the module package.

After the test server and browsers have stopped, the disposable cache can be
removed at **`node_modules/.cache/assistant-browser`**. This removes only the
harness's isolated Git checkout, generated host bundle/styles, reports, runtime
scratch files, and optional project-local browser downloads. It does not remove
the module's `dist/web` output or any existing host checkout. Rebuild the fixture
(and reinstall Chromium if its project-local download was removed) before the
next run. Do not remove the cache while tests are running.

For an existing local host object database, set
`COCKPIT_FIXTURE_SOURCE=/path/to/cockpit`; the requested revision is still checked.
`COCKPIT_BROWSER_DEPENDENCIES=/path/to/cockpit/apps/web` optionally resolves the
host's existing Sass/icon development dependencies. CI should use the ordinary
repository dependencies and public Git fetch instead.

To keep browser downloads project-local, use the same
`PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/assistant-browser/browsers"`
for the install and test commands. `ASSISTANT_BROWSER_PORT` selects a free
loopback port (default 4179); existing servers are never reused.

## Integration boundary

- The pinned host's unmodified `ModuleRuntime`, `ModuleRuntimeProvider`,
  `ModuleGlobalComponents`, `AnchoredMenu`, `useRegisteredMenu`, menu buttons,
  error boundaries, and complete host SCSS are bundled only for testing.
- The real runtime fetches a synthetic module manifest and dynamically imports
  the production module bundle; it owns registration and invokes the real
  Assistant global-menu action. The renderer and menu share one React tree and
  runtime. The homepage initially has no selected session; a synthetic selection
  and host draft verify that closing Assistant preserves the existing view.
- Only the host `net/store` import is replaced with an empty session snapshot.
  Native draft submission throws instead of making a request. The fixture does
  not import the host App or initialize its networking/authentication.
- Playwright supplies deterministic timeline, readiness, internal activation,
  and POST/receipt responses. A loopback-only server supplies idle synthetic SSE;
  tests inject duplicate/out-of-order publications and catch-up responses.
  Unexpected module requests, host API requests, and external requests fail.

This is a public-module/real-host-component integration test, not a deployed-host
smoke test. It does not claim to test native session creation or real delivery.

## Matrix and evidence

Every scenario runs in desktop/mobile Chromium with light/dark themes. Tests
cover complete Markdown and A/B/A topic segments, fixed composer visibility,
immediate settings visibility even when initial history is delayed,
readiness-gated sending with editable drafts, exact role names and Cockpit role
registration guidance without manual registration or reception forms, public
arrow/gear icons with native dialog return and preserved host selection/draft,
captured role/session/epoch activation, pending and unknown load receipts across
reopen without new-ID retries or invalid-role repair, reply anchors and question
choices (including six 120-character choices without hiding the mobile composer),
retained question choices outside the reopened timeline without duplicate controls,
stable uncertain request identities, late writes after close/reopen,
older-message paging, SSE recovery/deduplication, reading-position preservation,
and unread-message navigation. Screenshots contain synthetic data only.

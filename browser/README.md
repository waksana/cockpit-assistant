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
  public Composer/Message/Attachment components, draft owners/schemas, error
  boundaries, and complete host SCSS are bundled only for testing.
- The real runtime fetches a synthetic module manifest and dynamically imports
  the production module bundle; it owns registration and invokes the real
  Assistant global-menu action. The renderer and menu share one React tree and
  runtime. The homepage initially has no selected session; a synthetic selected
  Chat uses the real host `Composer` and `SessionDraft`. Both background Chat and
  Assistant traverse the same public Composer middleware chain, with distinct
  draft references. Closing Assistant preserves the host view and native draft.
- Only the host `net/store` import is replaced with an empty session snapshot.
  Native draft submission throws instead of making a request. The fixture does
  not import the host App or initialize its networking/authentication.
- `?probes=1` activates a test-only API-v3 module. Synthetic File/Speech controls
  use the published SDK's real `registerDraft`, `bindDraft`, persistence,
  projection, item/version ACK and captured-send APIs. They operate only on
  Assistant; background native controls are deliberately disabled. There is no
  microphone, upload, actual File/Speech product, native transport, or external
  service. All native send entry points throw and are counted.
- Playwright supplies deterministic timeline, readiness, internal activation,
  and POST/receipt responses. A loopback-only server supplies idle synthetic SSE;
  tests inject duplicate/out-of-order publications and catch-up responses.
  Unexpected module requests, host API requests, and external requests fail.
- POST fixtures retain a deep copy of the full original input, including native
  attachment descriptors; GET receipts return that immutable input independently
  of message/work state. A successful POST alone is not acceptance proof.

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
and unread-message navigation. The draft-owner matrix additionally covers
attachment-only sends and historical attachments, public identity without invented
native origins, all four native attachment descriptor types, retained edits and
reply changes during ACK, unknown and pending recovery after reload without POST
replay, field ACK failures, revoked schema generations and rehydration, expired
captured consent, choice-only/attachment-forbidden asks, and real input IME guards.
Mobile Enter retains the host's newline behavior. Screenshots contain synthetic
data only.

`test/frontend-host.ts` also bundles the same pinned runtime for store orchestration
tests. It activates the store using real public state registration and isolated
in-memory draft storage; it does not substitute an owner implementation. A cold
`npm test` therefore fetches the pinned host fixture if absent. No browser or
production `dist` build is required for these Node tests.

# Releases

## Automatic Rolling

Every PR actually merged to `main`, including documentation and chores, starts
`Rolling` (`.github/workflows/rolling.yml`) on `pull_request_target: closed`.
There are no path or label filters, catch-up releases, or shared concurrency
groups that can displace another merge. Closing without merging publishes nothing.
The introducing PR is itself the first eligible merge.

The workflow's `github.run_number` is the permanent repository-local sequence.
Do not rename, delete/recreate, or reset this workflow. Reruns keep their sequence;
gaps are normal. Consumers select the greatest compatible sequence, never the
last completion timestamp or GitHub Latest.

The workflow calls the same reusable CI as PR checks at the exact merge SHA,
including build, tests and isolated pack closure. Publication
independently confirms the PR's merged state, main base, merge SHA, checkout and
main ancestry. It never checks out a contributor head. PR title/body are read
from event JSON as data, never interpolated into shell commands. Checkout
credentials are not persisted; package read credentials are limited to install.

Source package, lock and module manifests remain `0.0.0-dev`. A private packaging
stage receives `0.0.0-rolling.N`; no generated version is committed. The immutable
lightweight tag `v0.0.0-rolling.N` points to that exact merged commit.
The npm SDK dependency is pinned exactly in `package.json` and the lockfile,
and independently published to GitHub Packages. Its version is not a substitute
for the host capability checks below.

Each Release contains exactly four assets:

- `cockpit-assistant-0.0.0-rolling.N.tgz`
- `cockpit-assistant-0.0.0-rolling.N.tgz.sha256`
- `cockpit-deployment.json`
- `cockpit-deployment.json.sha256`

The tar archive contains the module at `./`, not a host runtime bundle or an
extra npm `package/` directory. It includes compiled backend, roles,
documentation, injected manifests and `module-build.json` (source SHA, version,
Node/platform/architecture and SDK). The descriptor is byte-identical at the
archive root and as a sidecar. Format 2, channel `rolling`, uses the public
[host release contract](https://github.com/waksana/cockpit/blob/main/docs/releasing.md).
Independent checksum files avoid a self-referential archive digest.

The product is module **`assistant`**, backend API 1, requiring `shutdown.v1`,
service readiness, session load, prompt receipts, public session directory,
Chat reads and role assignment/availability. No module
frontend/UI, resource-isolation or prompt-origin capability is required by the
support service. MCP attribution retains native invocation/session/tool-call
identity. The agent's separately configured Host MCP tools have their own native
requirements. Missing service capabilities fail before opening data.
`shutdown.v1` requires the early stopping signal and awaited `onStop`/`dispose`
contract; installing a newer SDK alone does not establish Host support.
Required intents combine actual backend host calls and the role's direct Host
MCP dependencies, including `session/chat/text`, creation and ask answers.
The latter are not service routing wrappers and require no module SDK upgrade.
An older Host lacking lightweight text support must not accept this release.
Packaging checks the main database's four active tables:
`topics`, `deliveries`, `mailbox` and `seen`.
The actual packaged activation also creates and checks the independent
`recent.sqlite` schema-1 cache without requiring a main-database migration.

The session-directory/pointer-inbox change retains these exact schema-5 definitions
and every existing topic, mapping and history. Its additional values in `seen`
are namespaced, bodyless source/inbox-range/agent-handling receipts, not a new schema
or business-status snapshot. New reply rows hold source pointers; old unread
bodies are not rewritten on startup. Explicit handling archives their original
rows in-place using bodyless receipt markers; no body copy or bulk deletion occurs.
New pointer rows leave the mailbox when handled. Legacy dispatch/provenance/creation records remain inert, never
replayed. No production registry cleanup or foreground migration is part of this release. The independent rebuildable
`recent.sqlite` schema-1 database stores only bounded recent primary text and
source/synchronization metadata. It does not alter schema 5 or read/handling
checkpoints. Old foreground choices remain inert; actual saved coordinator roles
determine the reminder target. No existing role or connector binding is migrated.
The advertised schema-4-to-5 migration below therefore remains necessary and
unchanged, rather than being replaced by an empty migration list.

The descriptor declares schema 5 and one explicit **nondestructive 4-to-5**
migration for the currently deployed database. The deployment service accepts
only one source-to-target migration per database, not alternative entries.
The offline utility separately supports a checkpointed schema-3 upgrade when
explicitly invoked; that is not an advertised automatic schema-3 path.
Existing topic columns remain the deployment preservation projection.
The offline migration additionally fingerprints every old table's exact columns,
row IDs and values before and after its transaction. Published schema-3/4 layouts
are independently pinned, not inferred from target-only definitions.

Old message mirrors and delivery records stay as inert archive tables in the
migrated database; fresh stores do not create them. Runtime code neither reads
nor writes those archives. Schema-4 unread bodies, attachments and questions move
into the active mailbox without automatic notification or replay. Consumed
native IDs become bodyless tombstones; absent body hashes are not fabricated.
No old pending human input or delivery becomes new work.

The packaged `dist/migrate.js` implements the deployment service's existing
preflight/apply hook contract. The preflight is read-only; apply uses an explicit
SQLite transaction. It takes a checkpointed offline module data directory and returns only the
declared JSON confirmation on standard output. It never calls Host/session
APIs or resets data.

There is no migration or reset claim for schema 1, schema 2 or an incompatible
schema-3/4 draft. These are rejected unchanged. A nonempty WAL must first be
captured through the deployment service's SQLite-aware snapshot; preflight must
not ignore it or create sidecars. Migration success is not permission
to deploy or restart a running service.

`pack:check` loads the actual packaged backend in isolated data directories.
It exercises the actual packaged migration entry against retained synthetic
schema-3/4 originals, questions, mappings, unread results and native receipts.
It compares every old field before/after, checks read-only preflight and repeated
apply, and proves that incompatible schema 1/2/draft inputs remain
unchanged. No production database or native session is used.

Publication creates a draft prerelease, uploads each asset once, downloads every
asset by ID, checks API digest/size, checksum, archive identity and embedded
descriptor, then seals the original release/asset IDs in the notes. The single
publishing PATCH sets the sealed body, `draft: false`, `prerelease: true` and
`make_latest: false`. Final readback re-verifies the same identity and bytes.
Notes preserve the triggering PR's complete title/body, URL, SHA, tag, version,
sequence and all four asset digests. Assets and tags must never be replaced.

## Verification and recovery

Local script tests (synthetic fixtures only, not deployable packages):

```sh
node --import tsx --test test/release*.test.ts
```

### Native Host consumer probes

The original pointer-inbox integration was exercised against the sealed
[Host Rolling 36](https://github.com/waksana/cockpit/releases/tag/v0.0.0-rolling.36)
runtime, source `5d9191a9aa5f5e7fded65154982e99773066bc09`.
Its `runtime.tar.gz` is 55,944,190 bytes, SHA256
`ebd157eb65b42c913323be6345b7469b06c9b5d515e3dcb9abca4eb6fb0a7fd1`.
That artifact's process-key positions do not establish restart-safe consumption.
Stable caller-owned positions require the corrected
[Host Rolling 37](https://github.com/waksana/cockpit/releases/tag/v0.0.0-rolling.37)
or a later compatible Host. Rolling 37 source is
`af5bad83ec9ba421483ea0660d2b46a49e0df146`; its `runtime.tar.gz` is
55,946,044 bytes, SHA256
`f236ffcfec32926a12de70160bc7573cfca3f5723e28d3bddb1674761d503476`.
The deployment descriptor's required-intent presence alone cannot distinguish
these text-position formats; use the stated Host dependency for restart recovery.
Select and verify the published artifact before extracting it; these scripts
take an extracted runtime directory, never a production service URL:

```sh
npm run build
for probe in evidence response session; do
  taskset -c 0,1 prlimit --as=17179869184 -- node \
    --max-old-space-size=2048 --disable-wasm-trap-handler \
    "scripts/native-$probe-check.mjs" /absolute/path/to/verified-host-runtime
done
```

The controlled provider chooses synthetic actions; the actual native runtime,
ordinary role, immutable tool scope, external `cockpit` stdio MCP, tool calls,
Chat events and ask callbacks are real. Probes create isolated homes, configuration,
module data and loopback endpoints, clean successful fixtures and retain failed
ones for diagnosis. They do not use production sessions or connector bindings.
The evidence probe preserves genuine Host `since`/checkpoint tokens through
partial read reports and recovery before exact-ID handling, including concurrent
arrivals, bounded Unicode fragments and passive unloaded reads. Response and
session modes cover current asks, queued/steered prompts and original-ID wakes.
Cold lifecycle `SESSION_TRANSITION` diagnostics are reported explicitly, not
treated as successful delivery; unrelated errors fail the run.

These are consumer integration probes, not a proof of model judgment or human
delivery. The Host owns pagination and token-expiry behavior; see its
[text contract](https://github.com/waksana/cockpit/blob/v0.0.0-rolling.37/docs/native-chat.md#bounded-text-view).
Production foreground creation/selection and deployment remain separate actions.

### Complete Host process restart

The stable-position consumer probe uses a controller/provider process and a
separate Host OS process. It waits for that Host to exit, then starts another
Host against the same isolated native persistence and Assistant database. This
is not a reader reconstruction or a native-child-only restart:

```sh
npm run build
taskset -c 0,1 prlimit --as=17179869184 -- node \
  --max-old-space-size=2048 --disable-wasm-trap-handler \
  scripts/native-restart-check.mjs /absolute/path/to/verified-host-rolling37
taskset -c 0,1 prlimit --as=17179869184 -- node \
  --max-old-space-size=2048 --disable-wasm-trap-handler \
  scripts/native-restart-check.mjs /absolute/path/to/verified-host-rolling37 \
  --legacy-host /absolute/path/to/verified-host-rolling36 --change-partial-page
```

`--keep-evidence` retains the isolated synthetic fixture for explicit local
inspection; without it successful fixtures are removed. Never commit native
transcripts or fixture directories.

The two runs against the exact artifacts above completed with 81/91 provider
requests and 56/63 genuine MCP calls respectively. All six Host processes exited
cleanly. The consumer recovered Assistant-owned positions and partial progress,
read ten-page incremental ranges across shutdown/restart, retained unread
concurrent arrivals after older handling, and reassembled a 25,016-byte Unicode
body while the source remained unloaded. A real append forced
`TEXT_PAGE_CHANGED`; explicit replay retained the original `since` and pending
receipt. A real public rewind produced a history gap without advancing or
acknowledging unread positions. Original Rolling 36 positions were consumed
unchanged by Rolling 37 and migrated only after the complete range.

The runs reported 14/18 expected lifecycle-transition diagnostics; those are not
business completion signals. Actual native `TEXT_CURSOR_EXPIRED` and initial
history recovery without a checkpoint were not induced by these runs. Their
recovery contract remains explicit in the [API](api.md#read-positions); they are
not claimed as native execution evidence. No Host read-state table, Assistant
body mirror, new tool permission or production migration was introduced.

### Packaging and publication

The Actions packaging command, after CI and build in a clean committed checkout:

```sh
ROLLING_SEQUENCE="$SEQUENCE" SOURCE_SHA="$(git rev-parse HEAD)" \
  node --import tsx scripts/release-package.mjs
```

`release-artifacts` must not exist. Local packaging is not permission to publish
or deploy; only verified GitHub Release assets are deployment inputs.

Each remote write has one attempt. A timeout/lost response is **unknown**, not
permission to retry. The publisher reads back for diagnosis and stops all writes.
Inspect the Actions run and exact tag/Release/assets before an explicitly
authorized rerun:

```sh
gh run view RUN_ID --repo waksana/cockpit-assistant
gh release view v0.0.0-rolling.N --repo waksana/cockpit-assistant
gh run rerun RUN_ID --repo waksana/cockpit-assistant
```

A rerun may retry a build before publication, or verify an already published,
sealed Release without writes. It downloads the original bytes, never replaces
them with a rebuild. Existing drafts (including partial uploads) fail closed and
need separately authorized inspection; automatic draft repair, replacement,
deletion and republishing are deliberately absent. A tag-only failed attempt can
continue only when the original immutable tag still matches the original SHA.
Never move a tag or reuse a sequence for different source.

Publication does not install a module, migrate data, create sessions, send
production prompts, restart a host, or authorize external deployment. Milestone
promotion is not implemented by this workflow.

## Existing automatic deployment service

The external automatic checker, not this repository's workflow or an agent,
selects and deploys compatible published Rolling releases. Assistant is a new
module: its separately authorized registration uses module ID `assistant` and
repository `waksana/cockpit-assistant` in the service's Rolling module mapping,
alongside the required explicit installation/baseline registration. A release
does not implicitly add a module. Registration and its operational verification
belong to the deployment operator; this repository changes no controller source,
site configuration, host selection, or live data.

After registration, each new release is discovered from its verified descriptor;
ordinary releases do not require manual catalog edits. The existing checker reads
all published releases, checks both descriptor copies and independent archive/
descriptor checksums, and chooses the highest compatible non-decreasing sequence.
It does not use GitHub Latest. An unchanged target does not request a restart;
uncertain or failed deployment pauses the checker instead of triggering a retry
or automatic rollback.

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

The product is module **`assistant`**, backend API 1, requiring service readiness,
chat reads, ask responses, role assignments, session load, native tool scope,
exclusive role resources and prompt-origin observations. No module frontend/UI
capabilities are required. Foreground attribution uses actual native acceptance
and MCP `toolCallId` metadata. Missing capabilities fail before opening data.
Required intents are extracted from actual backend host calls. Packaging creates
the target database in memory and checks its four active tables:
`topics`, `deliveries`, `mailbox` and `seen`.

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

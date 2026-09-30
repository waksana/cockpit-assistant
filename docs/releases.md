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
including build, tests, browser checks and isolated pack closure. Publication
independently confirms the PR's merged state, main base, merge SHA, checkout and
main ancestry. It never checks out a contributor head. PR title/body are read
from event JSON as data, never interpolated into shell commands. Checkout
credentials are not persisted; package read credentials are limited to install.

Source package, lock and module manifests remain `0.0.0-dev`. A private packaging
stage receives `0.0.0-rolling.N`; no generated version is committed. The immutable
lightweight tag `v0.0.0-rolling.N` points to that exact merged commit.
The npm SDK dependency is exactly `0.11.1`, independently published to GitHub
Packages. Its version is not a substitute for the host capability checks below.

Each Release contains exactly four assets:

- `cockpit-assistant-0.0.0-rolling.N.tgz`
- `cockpit-assistant-0.0.0-rolling.N.tgz.sha256`
- `cockpit-deployment.json`
- `cockpit-deployment.json.sha256`

The tar archive contains the module at `./`, not a host runtime bundle or an
extra npm `package/` directory. It includes compiled backend/frontend, roles,
documentation, injected manifests and `module-build.json` (source SHA, version,
Node/platform/architecture and SDK). The descriptor is byte-identical at the
archive root and as a sidecar. Format 2, channel `rolling`, uses the public
[host release contract](https://github.com/waksana/cockpit/blob/main/docs/releasing.md).
Independent checksum files avoid a self-referential archive digest.

The product is module **`assistant`**, backend API 1, requiring public frontend
API 3, public components/conversation presentation/owner drafts v1, draft submission v2,
module pages/message presentation/menu/UI/surfaces v1, service readiness, chat reads, ask
responses, resource preparation, role assignments, session discovery and session
load v1. Coordinator invocation attribution additionally requires
`promptReceipt.v1` and native MCP `toolCallId` metadata. Earlier hosts without
these capabilities cannot run the coordinator protocol.
Required intents are extracted from actual backend host calls. Packaging creates
the real database **in memory** and checks that it has exactly `messages`,
`topic_messages` and `topics`. The descriptor declares `assistant.sqlite`,
schema 3, `preserve: []` and `migrations: []`.

There is no upgrade or reset contract for an incompatible existing database.
An empty preserve list means no row-projection queries, not permission to
discard data. In particular, a target-only `topic_messages` query must not run
against schema 1 or 2 before their incompatibility is detected. Such a transition
has no declared migration and must not be represented as a supported upgrade.
Fresh installation and compatible three-table schema 3 are separate from old
database replacement, which requires a separately authorized operator procedure.

`pack:check` loads the actual packaged backend in isolated data directories.
It verifies the fresh three-table layout and proves that real synthetic schema 1,
schema 2 and incompatible four-table schema 3 shapes are rejected without
changing their bytes or creating target tables. No production database or
native session is used.

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

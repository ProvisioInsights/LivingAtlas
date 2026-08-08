# ADR 0032: Backup and Restore for the Segment-Log Store

Status: Accepted for implementation
Date: 2026-08-08

## Context

The migration is applied. A real store exists in the new append-only segment-log
format — an `assertions/` directory and an `identity/` directory, each a set of
zero-padded NDJSON segments, plus two sidecars beside them,
`provisional-blocks.jsonl` (carried outline blocks, ADR 0029) and
`migration-apply.jsonl` (the apply audit trail, ADR 0030). It is served
**read-only** (ADR 0028).

The read-only posture is not a performance choice, it is a safety interlock, and
its stated reason is this ADR's whole subject: `backup-run.ts` /
`backup-restore.ts` understand only the OLD store's `snapshot.json` shape, read
through `LocalGraphMigrationSource`. There is no backup path for a directory of
NDJSON segments and two sidecars. So anything written into the new store today is
unrecoverable, and the honest response to "we cannot recover writes yet" is "then
do not accept writes yet." The frozen replica plus its verified old-format backup
is the recovery story for what was *migrated*; it is no recovery story at all for
what the new store is *written* afterwards.

This ADR defines backup and restore for the new format so that enabling writes
becomes a decision that *can* be made safely. It does not make that decision:
turning the store read-write stays separate and later (see Sequencing).

## Decision

### 1. The backup captures the whole store, and proves what it captured

`real-data:store-backup` copies **every file under the store root** — both
segment directories and every sidecar — into a fresh backup directory. There is
no allowlist of names to copy: the store's own rule is that the directory listing
is the manifest (there is deliberately no segment manifest file), so a backup that
enumerated only the names it happened to know about would silently drop a sidecar
a later ADR adds. It copies what is there.

The payload lands under `store/` inside the backup directory; a `manifest.json`
sits at the backup root. The manifest records, for each file:

- its POSIX-relative path within the store root (an ordinal segment name or a
  fixed sidecar name — never content);
- its byte length;
- its SHA-256, computed by `atlas-core`'s `digestOf` so the `sha256:<hex>` format
  cannot drift from the one the segment reader already uses to record discarded
  bytes.

and, for the store as a whole, the three markers that distinguish it from a
same-sized store: `feed_epoch`, `history_floor`, and `published_watermark`. These
are **re-derived by re-reading the assertion segments** (`scanSegmentLog`,
`repair: false`), never copied from a process counter — a value taken from the
run's own bookkeeping only proves the run is self-consistent, which is the one
thing it is guaranteed to be. This is the same standard the migration census and
compaction already hold themselves to.

The source is read, never written. A backup may run while the store is served
read-only.

### 2. Restore is all-or-nothing, and proves the store it rebuilt is the store

`real-data:store-restore` reconstructs a store from a backup, or fails with a
typed reason and leaves the target untouched. In order:

1. **It refuses a non-empty target.** A restore that merged into an existing store
   is how you get a spliced graph nobody can reason about. A merge is never
   silently performed.
2. **It reads and parses the manifest.** The manifest is untrusted bytes until
   parsed against a zod schema — it was written by a different process, possibly a
   newer one. A missing manifest is an *incomplete backup* (see §3), not an empty
   one.
3. **It verifies every artifact against the manifest BEFORE writing a byte into
   place.** A per-file size and digest check, plus a check that the payload holds
   no file the manifest never vouched for and exactly the recorded count. A single
   flipped byte or a dropped sidecar is caught here, against the backup, before the
   target exists.
4. **It stages the store in a temporary sibling directory**, then re-derives the
   three markers from the staged segments and matches them to the manifest. A
   manifest that lied about the markers while every file digest matched — a
   truncated capture, a swapped directory — is caught here. Byte-identity of files
   is necessary but not sufficient; the reconstructed store must actually *be* the
   store.
5. **Only then does it rename the staged directory into the target.** The target
   is populated by a single atomic rename of a fully verified store, or not at all.
   Any failure removes the staging directory and returns a typed result — never a
   partial store.

The round trip is proven end to end against the real `atlas-core` store classes:
a store the durable migration plane actually wrote is backed up, restored into a
fresh directory, and the restored directory is opened through the real read-only
reader (`openAtlasStore`) and shown to answer a read identically to the original.

### 3. An interrupted backup is detectable as incomplete

The `manifest.json` is written **last**, and atomically: to a temporary sibling,
fsynced, then renamed into place. Until that rename lands, the backup directory
holds a `store/` payload and no manifest, and restore refuses it as incomplete
rather than reconstructing a truncated store from a half-written directory. The
manifest also carries an explicit `complete: true` marker, so a hand-edited or
half-written manifest that omits it is refused rather than trusted.

### 4. The backup is cleartext at rest, and says so

`atlas-core` stores records **in the clear** behind 0600/0700 permissions;
redaction in the new store is an authorization decision on read, not encryption
(ADR 0028). A byte-faithful copy of a cleartext store is therefore cleartext too.
This is stated plainly rather than hidden: **the backup artifact must be treated
with exactly the same care as the store** — its payload files are written
owner-only (0600) under owner-only directories (0700), mirroring the store, and
the manifest and the optional report are **content-free**: paths, byte counts,
digests and store markers, never a record, a value, a name, or a block's text.
The result types have no field a value could be put in, so this is enforced by
shape rather than by care.

### 5. The entrypoints, and their guards

Two scripts, wired like the other `real-data:*` and `backup:*` runners:

- `real-data:store-backup` — `LIVING_ATLAS_STORE_DIR` (the store),
  `LIVING_ATLAS_STORE_BACKUP_DIR` (a fresh/empty backup directory),
  `LIVING_ATLAS_BACKUP_AUTHORITY_ID` (optional, stamped in the manifest),
  `STORE_BACKUP_REPORT_OUT` (optional).
- `real-data:store-restore` — `LIVING_ATLAS_STORE_BACKUP_DIR` (the backup),
  `LIVING_ATLAS_STORE_RESTORE_DIR` (a fresh/empty target),
  `STORE_RESTORE_REPORT_OUT` (optional). The target is deliberately **not**
  `LIVING_ATLAS_STORE_DIR`: a restore must never be pointed at the live served
  store by reusing the serving variable.

The report is a write, and writes are guarded (ADR 0031): the optional report path
runs through the same real-path, symlink-resolved comparison the migration
entrypoints use, so it cannot land inside the store or the backup and truncate a
segment or sidecar. The backup and its store must be disjoint trees, as must a
restore target and its backup — a backup nested in the store would capture itself
and, worse, write into a store that is supposed to be read-only.

The backup's durable, inspectable event is the manifest itself: one per run,
carrying aggregate counts (artifact count, total bytes) and the store markers. A
restore cannot record its event *inside* the store without breaking the
byte-identity it exists to guarantee, so its durable, content-free record is the
optional report and its stdout line.

## Sequencing

This **unblocks** enabling writes; it does not enable them. With a backup and a
proven restore for the new format, the argument that kept the store read-only —
"a write here is unrecoverable" — no longer holds. Turning the store read-write is
a separate decision with its own risks (a second writer, compaction, the write
tools' authorization surface) and is made in its own change, not here. Neither
this ADR nor its scripts open the store for writing.

## Open question

**Should the backup be ENCRYPTED at rest?** — OPEN.

The old store's backup path wrapped its artifact under a recovery master and could
carry an escrow envelope or a recovery bundle; this backup ships the artifact in
the clear because the store it mirrors is in the clear. That is defensible for a
local, owner-only artifact on the same machine as the store — the backup is no
more exposed than the store, and both are 0600/0700. It is **not** obviously
right the moment the backup leaves that machine: a cloud copy, an external drive,
or a backup directory synced by a consumer file-sync client would put cleartext
personal-graph bytes somewhere the store's filesystem permissions do not reach.

Recommendation: keep the on-disk artifact cleartext for the local, same-host case
this ships, and treat encryption as a property of *transporting or offsiting* the
backup rather than of writing it — an at-rest envelope keyed by the same
keyholding-first model the architecture already mandates (keep sensitive plaintext
local/keyholding-client first; do not design a remote service that can decrypt the
full graph). This is recorded as OPEN rather than decided: shipping
"cleartext forever, everywhere" as if it were settled is exactly the kind of quiet
privacy decision AGENTS.md forbids.

## Consequences

- The new store now has a recovery path, closing the gap that forced it
  read-only, and providing the precondition for a later read-write decision.
- A restore either produces a store that opens, serves, and matches its manifest,
  or it produces a typed failure and an untouched target. There is no partial
  store outcome.
- The backup artifact carries the same disclosure risk as the store and must be
  handled with the same care; whether to encrypt it before it leaves the host is
  open, with a recommendation above.
- The scripts touch only synthetic fixtures in tests and operator-supplied paths
  in production; they never write to the store they back up.

# ADR 0017: Retiring The Legacy Local Surface, And The Read-Only Migration Source

Status: Accepted for implementation
Date: 2026-08-04

Supersedes: [ADR 0002](adr-0002-policy-scoped-mcp.md),
[Local MCP Boundary](local-mcp-boundary.md),
[Local MCP Authentication](local-mcp-authentication.md)

## Context

ADR 0013 published a consumer contract, ADR 0014 built the server that serves it,
ADR 0015 added the operator plane and capability grants, and ADR 0016 wired five
anti-drift gates around all of it. The replacement exists. This ADR removes what
it replaces.

What was there:

- **Thirty tools** registered in `packages/local-mcp/src/server.ts`, served over
  stdio directly (`cli.ts`), over a Unix-socket daemon (`daemon.ts`,
  `daemon-socket.ts`, `proxy.ts`), and over a loopback Streamable HTTP listener
  (`http-listener.ts`).
- **`packages/local-review-site`**, a third authenticated writer: an HTTP server
  bound to `127.0.0.1` with a browser app, `POST /api/review/bulk/decision`, and
  `resolution-apply`.
- **Twenty-four of the twenty-seven rows** in the ADR 0016 quarantine ledger,
  every one of them describing the local server: twenty-one input shapes authored
  twice (zod in the server, JSON Schema in the catalog) and disagreeing, two
  redeclared tool-name sets, and four advertised tools routed to
  `localUnsupportedTool`.

## Decision

### 1. The local 30-tool surface is deleted; the library under it is kept

Deleted: the tool registration, all four transports, the env-to-context builder,
the bearer-token server wrapper, and the `review_list` / `review_read` /
`review_decide` handlers.

Kept: `local-graph.ts`, `auth.ts`, `audit.ts`, `activity.ts`, `outbox.ts` — the
graph commands, the local credential check, and the three sinks.

**Why kept.** The stated method for this work is "prove it is unreferenced,
delete; if something is still referenced, do not delete it — mark it superseded
and report why." A measured import scan found every surviving external consumer
of `@living-atlas/local-mcp` uses only the library: `localCreateObject`,
`localReadObject`, `localUpdateObject`, `localTombstoneObject`,
`localSearchObjects`, `localTraverseGraph`, `localTimelineQuery`,
`localActivityRead`, `localResolutionApply`, `createLocalMcpContextFromControlState`,
and the sinks. The consumers are the migration and operational runners in
`packages/check` — the Logseq import path, the canonical isolated-copy runner,
the backup and readiness proofs. Deleting the library strands the migration that
is waiting on offline media, which is the thing this work is explicitly
forbidden to do.

The package therefore no longer registers or serves any MCP tool. **Its name now
overstates what it contains, and renaming it is an open question** — see below.

### 2. `packages/local-review-site` is deleted; two files were relocated, not removed

Deleted: the HTTP server, its 1,408-line test, the browser app, the stylesheet,
and the one-line re-export of `@living-atlas/review-projection`.

Relocated:

- `review-auto-apply.ts` and its test → `packages/check/src/`. This is not the
  approve/reject workflow; it is the exact-preservation **auto-apply planner**,
  and its only consumer is `canonical-isolated-copy-runner.ts` — migration
  tooling. It cannot live in `packages/review-projection`, which `local-mcp`
  imports, without creating a cycle.
- `review-projection.test.ts` → `packages/review-projection/src/`. Its 993 lines
  test `@living-atlas/review-projection`, a package that survives; it was parked
  in the site's directory. Deleting a kept package's test suite alongside the
  site would have been a silent coverage loss.

The interactive workflow itself is the operator plane's job (ADR 0015,
`atlas.ops.review.queue.read.v1`).

### 3. `packages/local-graph-store` gains a read-only migration handle

⚠ **This deviates from the instruction as written, and the deviation is the
point of this section.**

The instruction was to reduce the package to a read-only migration reader:
remove the mutation path, keep the ability to open and read a snapshot, and make
any write attempt throw. The premise is that the legacy write path was the only
writer. **Measured, it is not.** Twenty-plus non-test call sites still mutate a
`FileLocalGraphStore`, in packages this run is explicitly told to keep:

| caller | mutators used |
|---|---|
| `packages/check` — Logseq semantic/topic/offering import, connector enrichment, parity, refresh-reconcile, tombstone-orphans, tiering, bidirectional sync | `createObject`, `updateObject`, `tombstoneObject`, `compact` |
| `packages/sync-agent` | `createObject`, `updateObject` |
| `packages/atlas-client` | `commitTransaction` |
| `packages/local-mcp` (the kept library) | all of them |

Those are the writers that put migrated data *into* a local replica. Making
every write throw would break the migration rather than protect it.

**So the property enforced is the one the rewrite plan actually states** —
INV-3, "the old store gets no mutating handle" — and it is enforced at the point
a handle is created, in code:

`LocalGraphMigrationSource.open({ directory })` returns a handle that

- **never creates the directory.** `FileLocalGraphStore.open` mkdir's, so a
  typo'd path yields a store that reads as "the replica is empty" rather than
  "the replica is not there", and a migration against nothing looks like a
  migration that found nothing to do. The migration source throws instead.
- **replays snapshot + journal and exposes the full state** through `status()`,
  `listObjects()`, `readObject()`, `materializedSnapshot()`, `migrationHistory()`
  and `journalEntries()` — everything a compaction would have written, without
  writing it. That is the argument for refusing compaction rather than allowing
  it "just to read", and it is asserted by a test that compares the materialized
  snapshot against what a real `compact()` produces on the same directory.
- **refuses every mutator by name**, throwing `LocalGraphStoreReadOnlyError`
  with `code: "local-graph-store-read-only"`: `createObject`, `updateObject`,
  `tombstoneObject`, `commitTransaction`, `initializeFromObjects`,
  `openMigrationWindow`, `sealMigrationWindow`, and `compact`.

Two enforcement layers, deliberately:

- The class carries **private fields**, so TypeScript will not let it stand in
  where a `FileLocalGraphStore` is expected. The honest mistake does not compile.
- Every mutator **exists and throws**. A cast, a `Record<string, unknown>`
  round-trip or a dynamic dispatch — the other mistake — fails loudly at the call
  instead of silently doing nothing.

The two named defects are named in the code that refuses them:

- `compact()` writes the collapsed snapshot and then truncates `journal.jsonl`
  to empty. Every intermediate version the snapshot does not carry is gone.
- every mutation replaces the object's envelope in the materialized map, so the
  snapshot only ever holds the latest version; compaction then makes that the
  only thing on disk.

Neither is a bug in a live replica. Both are fatal for a replica that is the last
copy of what it holds until the migration lands.

Two read-only consumers were repointed at the new handle, so the reduction is
real rather than notional:

- `packages/check/src/backup-run.ts` — its comment already claimed it
  materialized "without compacting the source replica"; that is now enforced by
  the handle. A backup that could truncate the journal of the replica it is
  backing up is the one thing a backup must not be.
- `packages/check/src/local-backfill-outbox.ts` — `stageBackfillOutbox` now
  takes `LocalGraphReadHandle`, the read surface both handles satisfy, so a
  caller that only enumerates cannot be handed a writer by accident.

**Reversal, one line:** delete `LocalGraphMigrationSource` and repoint those two
callers back at `FileLocalGraphStore.open`. Full deletion of the package remains
W44's job, gated on the migration completing.

### 4. The quarantine ledger loses twenty-four rows, and says so

ADR 0016 built the ledger to fail in three directions, and the third — a row that
matches nothing — is the one this change triggers. The rows were **not fixed**;
the code they described was demolished, which is a different thing and is stated
plainly in the registry comment. Nobody reconciled twenty-one zod schemas against
a catalog.

`probeLegacyPlane` is deleted with them: it read the local server's
`LocalMcpToolInputSchemas` and the `localUnsupportedTool` routing in the local
dispatch, and both are gone. The plane keeps `redeclared-tool-name-set` and
`transport-varying-limit` over the surviving remote half
(`packages/mcp-contract`, `packages/graph-service`), and records
`input-schema-divergence` and `advertised-tool-unimplemented` in `notApplicable`
with the reason — because ADR 0016 makes a silently-not-running detector a build
failure.

### 5. Live documents may not name what no longer exists

`docs/mcp-tools.md` (the 30-tool catalog) and
`docs/architecture/local-mcp-clients.md` (connection instructions for the deleted
daemon, socket proxy and HTTP listener) are deleted.

ADR 0002, `local-mcp-boundary.md` and `local-mcp-authentication.md` are marked
superseded with links, and their bodies are left as written. An ADR is a record of
what was decided, not a description of what the code does.

A gate enforces the distinction: `packages/atlas-gates/src/retired.test.ts` fails
when any live Markdown document names a package or path this run deleted. Two
exemptions, both principled:

- a document whose header says **Superseded** may name what it described — that
  is what being superseded means;
- `docs/superpowers/` is excluded. Those are dated plan artifacts recording work
  that was done at the time. Rewriting them would be editing history, which is
  exactly what the "supersede rather than edit" rule forbids.

## Consequences

- **There is currently no supported way to point an MCP client at a real graph.**
  The retired surface could; the replacement serves an empty in-memory graph by
  design, and binding a durable store to it is a separate reviewable act. This is
  stated in `docs/getting-started.md` rather than papered over. The replica is
  untouched, read-only, and still backed up.
- **Clients on a 2025 protocol revision cannot connect at all.** `serveStdio`
  runs `legacy: 'reject'`. Accepted in the scope of this work and not designed
  around.
- **`npm run local-mcp:fixture` and `npm run mcp:inspect:local` are gone.** No
  Inspector script replaces the latter: the Inspector opens with a 2025-era
  `initialize` and would be refused, and a documented command that cannot connect
  is worse than no command. The published schemas in
  `packages/atlas-contract/schema/` are the discovery surface it stood in for.
- **`npm run smoke:local` and `npm run local:deploy-synthetic` no longer spawn a
  server.** Both drove the deleted stdio binary as a subprocess, and no assertion
  in either was about the transport — every one reads a file the run produced or
  a value a graph command returned. Both now call the library directly, so the
  leakage guards run against a real journal instead of an empty one, and both
  were executed to green rather than assumed.

## Open questions

Marked open rather than decided in passing.

1. **`@living-atlas/local-mcp` is a package named for a server it no longer
   contains.** The rename is mechanical — roughly ten import sites in
   `packages/check` plus the lockfile — and was left out of this change to keep
   the demolition diff reviewable. A name that overstates its contents is exactly
   the drift the gates exist to catch, and no gate catches this one.
2. **Whether the operator plane's review queue is a sufficient replacement for
   the review site's bulk-decision workflow** has not been demonstrated against
   the corpus. The site produced the curation decisions this migration exists to
   preserve; W06/W09 must carry them before anyone relies on the replacement.
3. **`packages/activity-replay` and `packages/local-decryption-oracle` are
   unreferenced leaves** — measured, not assumed — but they were leaves *before*
   this change, not because of it, and neither is superseded by the new planes.
   They are reported, not deleted. Their disposition belongs to W47.
4. **The remote half of the legacy surface is untouched.**
   `packages/mcp-contract`, `packages/graph-service` and the worker still publish
   and enforce the 30 tools, and still carry the three ledger rows: the deny list
   that names four tools where the contract names six, the batchability set
   declared in enforcing code, and the 100-vs-10 batch cap chosen by transport.
   Cloudflare was out of scope for this run; W43 removes them.
5. **Whether a migration source should also refuse to open a directory that a
   `FileLocalGraphStore` currently holds open** is not addressed. Nothing
   coordinates the two handles today, and a compaction racing a read would be
   invisible to both.

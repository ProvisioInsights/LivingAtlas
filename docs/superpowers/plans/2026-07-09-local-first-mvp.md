# Local-first MVP implementation plan

> **Execution:** Implement on `codex/local-first-mvp` with test-first changes. The
> scope is GitHub #37, #39, #38, #40, and #41 only; #42 forbids cloud, remote,
> sync, provider, multi-device, hosted, visual, and deployment work.

## Goal and proof

On one trusted Mac, a synthetic Markdown corpus is imported into an encrypted
local graph, an authenticated stdio local MCP queries and corrects it with a
redacted activity trail, and an encrypted backup restores into a separate
empty directory. The proof prints counts, IDs, hashes, and status only.

## 1. Keep the durable replica authoritative (#37, #39)

1. Add a local-MCP regression test that opens an empty durable graph and asks
   for a fixture-only object.
2. Run that test and confirm it fails because `readContextObject` falls back to
   synthetic objects even when a graph store is supplied.
3. Make the durable-store branch return only durable-store data; preserve the
   in-memory fixture branch for fixture mode.
4. Change CLI fixture seeding to require an explicit synthetic-seed switch,
   leaving a sealed local profile empty until import.
5. Update the existing synthetic installation smoke to request that explicit
   fixture seed and run its focused proof.

## 2. Capture a coherent graph image and recover without source mutation (#40)

1. Add a local graph-store test for a materialized encrypted snapshot after
   journaled mutations, without compacting or changing the source files.
2. Add a backup-run regression test: a journaled post-snapshot mutation must
   be present in the backup artifact and its manifest generation must match.
3. Add a retry regression test showing a partially written WORM backup does
   not reuse its immutable backup ID.
4. Expose a read-only materialized snapshot method on the local graph store.
5. Use that image in the backup runner and persist the consumed serial after a
   failed backup write, without recording an undurable backup as recoverable.
6. Run focused graph-store, backup-run, writer, and restore tests.

## 3. Supply one local-only end-to-end proof and runbook (#38, #41)

1. Add a synthetic-only proof command that creates sealed control/keyring
   files, imports a Markdown fixture, starts the actual stdio MCP, proves bad
   authentication rejection plus read/search/mutate/restart/activity, writes a
   backup, restores to a separate directory, and compares authority,
   generation, count, and object ID/version/content-hash sets.
2. Keep all proof output count/hash/status-only and scan generated files for
   fixture plaintext or credentials.
3. Add the `mvp:local-proof` script and a concise local-only runbook section
   documenting the command plus the owner-only real-corpus import boundary.
4. Run this command, `npm run check`, and inspect the final diff/status.

## Verification requirements

- No proof command invokes a cloud, remote MCP, sync, provider, or deployment
  script.
- Every production change has a regression test that was observed failing
  before its fix.
- The restored graph opens with the restored encrypted keyring in a different
  directory and matches the source before the backup attempt.
- Failed restore leaves the source graph hashes unchanged.

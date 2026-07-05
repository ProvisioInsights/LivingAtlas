# Data Tiering — Operational Runbook

Companion to `data-tiering.md`. This is the step-by-step procedure for
classifying the graph, reviewing the super-sensitive list, and (in a later,
coordinated phase) applying re-encryption.

## Prerequisites

- The local replica at `$R` = `~/Library/Application Support/LivingAtlas/personal-prod`.
- Keyring passphrase in the macOS Keychain, resolved at use — never printed:

  ```sh
  security find-generic-password -s io.livingatlas.personal-prod.keyring -w
  ```

- Run TS from the public repo (`<repo-root>`) via `tsx`.

Set the replica dir and passphrase for each command (the passphrase is resolved
into an env var only for the child process; it is not echoed):

```sh
export R="$HOME/Library/Application Support/LivingAtlas/personal-prod"
export LIVING_ATLAS_LOCAL_REPLICA_DIR="$R"
export LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE="$(security find-generic-password -s io.livingatlas.personal-prod.keyring -w)"
```

Alternatively, point the tools at the Keychain directly and never place the
passphrase in the environment:

```sh
export LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE=io.livingatlas.personal-prod.keyring
```

### Two-key model — key services

The two-key escalation model uses two distinct 32-byte secrets (see
`data-tiering.md` › Key management). Proposed Keychain services (provisioned in
the coordinated phase — not created by the read-only steps below):

| Key | Keychain service | Env override |
|-----|------------------|--------------|
| Primary cloud-unlock key | `io.livingatlas.personal-prod.cloud-unlock-key` | `LIVING_ATLAS_CLOUD_UNLOCK_KEY` |
| Escalation key | `io.livingatlas.personal-prod.escalation-key` | `LIVING_ATLAS_ESCALATION_KEY` |

The read-only Steps 1–4 synthesize their own throwaway keys; you do not need the
real keys to run them.

## Step 1 — Dry-run classification (read-only)

```sh
npm run real-data:tiering-dryrun
```

- Reads `$R/graph/snapshot.json`, classifies every live object.
- Writes `$R/tiering-dryrun.json` (mode 0600) with tier counts and the full
  super-sensitive match list.
- Prints the counts to stdout; the match list is referenced by file, not dumped.
- **Mutates nothing.**

## Step 2 — Eyeball the super-sensitive list

Open `$R/tiering-dryrun.json`. Each entry in `super_sensitive_matches` carries:

- `object_id`, `object_type`, `access_class`
- `matched_rules` — which rules fired
- `entity_names` — canonical entities extracted from the object (safe to read)
- `matches` — the exact `{rule_id, field, term}` that triggered each match

Review for:

- **False positives** (something local-only that is actually mundane). Known
  noisy terms: bare "clearance" can catch "limit clearance"; "medical" catches
  named medical institutions. These err on the safe side (kept local) but can be
  tuned.
- **False negatives** (something sensitive that was classified cloud-unlockable).
  If found, add a keyword / entity / tag to the relevant rule in
  `packages/policy/src/tiering.ts` and re-run Step 1.

The report intentionally contains **no decrypted plaintext bodies** — only
counts, matched terms, and entity names.

## Step 3 — Tier-coverage gate (read-only)

```sh
npm run real-data:tier-coverage
```

Proves, object by object (two-key model):

1. every **normal** object round-trips: re-encrypt → decrypt under the **primary**
   key succeeds (`cloud_unlock_roundtrip_failed == 0`);
2. every **super-sensitive** object round-trips under the **escalation** key
   (`escalation_roundtrip_failed == 0`) AND the escalation gate fires — it
   refuses to decrypt without the escalation key
   (`escalation_gate_refusals_failed == 0`);
3. no object is stranded host-blind — every live object is cloud-decryptable in
   some tier (`host_blind_stuck_objects == 0`,
   `every_object_cloud_decryptable == true`);
4. no super-sensitive object sits in the plain cloud-unlock class
   (`super_sensitive_in_cloud_unlock_class == 0`);
5. the independent full-body backstop finds no classifier false negatives
   (`exposure_backstop_hits == 0`).

Exit 0 = `complete: true`. Exit 1 = a coverage failure that must be resolved
before any apply. Read-only, in-memory; synthesizes distinct primary and
escalation keys unless `LIVING_ATLAS_CLOUD_UNLOCK_KEY` /
`LIVING_ATLAS_ESCALATION_KEY` are set.

## Step 4 — Synthetic escalation e2e (optional sanity)

```sh
npm run cloud-unlock:e2e-proof
```

Confirms the full two-key flow end to end: a normal sample decrypts under the
primary key; an escalated sample returns `escalation-required` when offered only
the primary key, then decrypts under the escalation key; wrong keys and
AAD-tamper are denied; and neither key nor plaintext leaks into the produced
objects.

## Step 5 — Live e2e (later, after worker redeploy)

```sh
LIVING_ATLAS_LIVE_CLOUD_UNLOCK_ACK=mutates-deployed-sync-state \
  npm run cloudflare:live-cloud-unlock-proof
```

Pushes normal + escalated objects to Cloudflare and unlocks them via the remote
MCP `sensitive_decrypt` tool — proving normal→primary, escalated→escalation-
required-without-the-key then decrypt-with-`x-living-atlas-escalation-key`, and
no key/plaintext persistence. Requires the live sync env
(`LIVING_ATLAS_LIVE_SYNC_*`, `LIVING_ATLAS_LIVE_CLOUD_UNLOCK_CAPABILITY_ID`).
**The escalation branch only responds correctly after the worker is redeployed
with the escalation handler (see below).**

## Coordinated real-data re-encryption phase (NOT done here)

Re-encrypting the real replica into the **two cloud tiers** is a **separate,
coordinated phase** and is intentionally not enabled in this build. The apply
path in `local-tiering.ts` is ack-gated
(`LIVING_ATLAS_TIERING_APPLY_ACK=reencrypt-two-key-tiers-real-data`) and, even
with the ack set, currently refuses with a clear error rather than writing.

When that phase is scheduled, the remaining work is:

1. **Pause the sync daemon** (real re-encryption mutates the snapshot/journal;
   the daemon must not race it). Not needed for Steps 1–4 above, which are
   read-only.
2. **Snapshot / backup** `$R/graph` (the repo already follows a
   `graph-backup-before-*` convention).
3. **Generate and provision BOTH keys.** Use
   `generateTieringKeyMaterial()` to mint a distinct primary + escalation pair;
   store each in its Keychain service
   (`io.livingatlas.personal-prod.cloud-unlock-key`,
   `io.livingatlas.personal-prod.escalation-key`). Carry **both** into the local
   sealed keyring with `addTieringKeysToKeyring()` so local decrypt of both tiers
   needs no escalation. Deploy the same key material as Cloudflare worker
   secrets/vars so the cloud unlock session can open each tier.
4. **Wire the apply path** in `local-tiering.ts` to route each object through
   `reencryptToTier` (normal → `cloud-unlock-v1` with the primary key,
   super-sensitive → `cloud-unlock-escalated-v1` with the escalation key,
   undecryptable → held on `local-keyring-v1`) and write results back through the
   graph store transactionally (lossless, idempotent — safe to re-run).
5. **Re-run the tier-coverage gate** (Step 3) against the re-encrypted replica
   and require `complete: true` before resuming the daemon.
6. **Push** the re-encrypted objects to Cloudflare (blocked on DEF-3, below).
7. **Redeploy the worker** so the escalation branch is live (see next section).
8. **Resume the daemon** and confirm sync health, then run the live e2e (Step 5).

Until that phase runs, personal-prod stays entirely `local-keyring-v1`; tiering
is proven and staged but not applied.

## Worker-redeploy requirement (escalation flow)

The worker's `sensitive_decrypt` handler now branches on the object's payload
algorithm class: a super-sensitive (`cloud-unlock-escalated-v1`) object returns
`escalation-required` unless the request also carries a valid
`x-living-atlas-escalation-key`. **This branch is code in the repo but is not yet
running on Cloudflare** — the deployed worker predates it. The escalation flow
therefore only takes effect **after the worker is redeployed**
(`wrangler deploy` from the private overlay repo). Do NOT deploy as part of this
phase; schedule it with the coordinated push. Until redeploy, escalated objects
that reach the live worker would be handled by the old single-key path.

## DEF-3 — Sync commit/persist ordering (generation-gap g298) — REDEPLOY-GATED, NOT APPLIED HERE

### Root cause

In `packages/cloudflare-worker/src/sync.ts` (`acceptSyncBatch`, sequencer branch,
~lines 232–258) the ordering is:

```
stageBatch()      // DO: marks the batch "staged" (idempotent-replayable)
commitBatch()     // DO: advances the authority-state generation
persistSyncBatch() // D1/R2: writes envelopes + flips the D1 batch row to "committed"
```

The D1-visible generation that readers observe (`readSyncStatus`) is derived from
**committed** rows in `sync_batches`, which only exist after `persistSyncBatch`
finishes. `commitBatch` advances the Durable Object's authority generation
**before** any D1/R2 write. A crash in the window between `commitBatch` and
`persistSyncBatch` therefore mints a **generation gap**: the DO believes the
generation advanced, but D1/R2 have nothing for it. Worse, the retry of the same
batch re-enters `stageBatch`, sees `state === "committed"`, returns
`should_persist: false`, and reports success **without ever persisting** — the
gap is permanent. This produced the observed **g298**.

### The exact fix (persist-before-commit)

Reorder so the idempotent D1/R2 write happens before the DO generation advance:

```
stageBatch()       // unchanged — batch is "staged", replay-safe
persistSyncBatch() // write envelopes to R2 + rows to D1 FIRST (idempotent:
                   //   INSERT OR IGNORE / INSERT OR REPLACE / R2 put)
commitBatch()      // advance the DO generation LAST
```

`persistSyncBatch` is already fully idempotent (verified: `INSERT OR IGNORE INTO
sync_batches`, `INSERT OR REPLACE INTO sync_objects/sync_changes`, R2 `put`, and a
conditional `UPDATE ... WHERE status='staged'`), so re-running it on retry is
safe. With this ordering a crash before `commitBatch` leaves the DO batch
`staged`; the retry re-persists (idempotently) and then commits — no gap.

### Why it is NOT applied in this change (failing-safe)

This reorder is **redeploy-gated and behaviourally risky**, so it is documented
only, not edited into `sync.ts`, per the safety-blocker scope:

1. **It requires a Cloudflare Worker + Durable Object redeploy** to take effect;
   the running g298-era worker is unchanged by a source edit alone.
2. **It changes a tested safety invariant.** The existing test
   `sync.test.ts › "does not commit graph storage when the sequencer commit
   rejects the staged batch"` asserts that when `commitBatch` returns
   `ok: false` (e.g. `batch-conflict`), **nothing** is persisted (0 R2 puts, 0
   D1 writes). Persist-before-commit persists first, then would have to handle a
   commit rejection — because `persistSyncBatch` self-commits the D1 batch row,
   naively reordering would leave committed D1 data for a batch the DO rejected.
   A correct reorder must therefore ALSO split `persistSyncBatch` so its final
   `UPDATE ... SET status='committed'` runs only after `commitBatch` succeeds
   (write envelopes + staged row → `commitBatch` → flip D1 row to committed), and
   update that test to match the new ordering.

Because it is not localized to a safe one-liner and needs a redeploy, the current
build is left **failing-safe**: the g298 gap only matters for the **phase-2
real-data push**; a working **supervised** push already exists and is unaffected.
Do NOT enable the phase-2 automated push until this reorder is implemented,
its test updated, and the worker redeployed.

### Redeploy steps (when scheduled)

1. Implement persist-before-commit in `acceptSyncBatch` and split the
   commit-flip out of `persistSyncBatch` as above; update the `sync.test.ts`
   ordering test.
2. `npx vitest run packages/cloudflare-worker` → all green (esp. the reordered
   commit/persist tests and the idempotent-replay tests).
3. Redeploy the worker + Durable Objects (`wrangler deploy` in the private
   overlay repo) and run the live concurrency/CRUD smoke checks
   (`cloudflare-live-concurrency-smoke`, `cloudflare-live-crud-stress`) to confirm
   no generation gap under crash/replay before resuming any automated push.

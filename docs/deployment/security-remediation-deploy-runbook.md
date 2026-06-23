# Security Remediation Deploy Runbook

This runbook is for applying the authority-scoped idempotency and audit-chain
hardening to an existing synthetic Cloudflare D1 deployment.

Do not use this as approval to import real personal graph data. Back up the D1
database before running migrations against any environment you intend to keep.

## What Changed

- `sync_batches.idempotency_key` is no longer globally unique. It is unique per
  `(authority_ref, idempotency_key)`.
- `remote_graph_writes.idempotency_key` is no longer globally unique. It is
  unique per `(authority_ref, idempotency_key)`.
- `audit_events` now has a unique authority-scoped `previous_event_hash` index
  so two writes cannot claim the same chain head.
- `/api/usage/*` requires `LA_USAGE_TOKEN_HASH` and the
  `x-living-atlas-usage-token` header instead of accepting the broader health
  token.
- Worker runtime configuration requires `LA_AUTHORITY_ID` so remote sync,
  remote MCP, audit, and cloud-unlock operations cannot silently cross
  authority boundaries.

## Preflight

Run the public checks before touching Cloudflare:

```bash
npm run check
npx tsx packages/check/src/cli.ts cloudflare-deploy-readiness
```

For an existing D1 database, run these duplicate checks before applying
`0005_security_remediation.sql`:

```sql
SELECT authority_ref, idempotency_key, COUNT(*) AS duplicate_count
FROM sync_batches
GROUP BY authority_ref, idempotency_key
HAVING duplicate_count > 1;

SELECT authority_ref, idempotency_key, COUNT(*) AS duplicate_count
FROM remote_graph_writes
GROUP BY authority_ref, idempotency_key
HAVING duplicate_count > 1;
```

Both queries must return zero rows. If either query returns rows, stop and
reconcile the duplicate synthetic data before applying the migration.

## Required Private Settings

Set these outside the public repo in the private deployment overlay or Cloudflare
secret store:

```text
LA_AUTHORITY_ID=<public authority id for this deployment>
BOOTSTRAP_CLAIM_TOKEN_HASH=sha256:<hex digest of bootstrap token>
LA_SYNC_TOKEN_HASH=sha256:<hex digest of sync token>
LA_USAGE_TOKEN_HASH=sha256:<hex digest of usage token>
LA_HEALTH_TOKEN_HASH=sha256:<hex digest of health token>
```

Keep raw token values in a password manager or local shell only. Do not commit
raw tokens, token hashes, account ids, private routes, `.dev.vars`, or D1/R2/KV
resource ids to the public repo.

## Apply

From the private deploy overlay, apply the D1 migrations with the environment's
private Wrangler config. The exact command belongs in the private repo because
it contains the real D1 binding, environment, and account context.

After migration, deploy the Worker version that includes the matching runtime
schema.

## Smoke

Use only tiny synthetic checks after deploy:

```bash
npx tsx packages/check/src/cloudflare-live-usage-gate.ts
npx tsx packages/check/src/cloudflare-live-mcp-tiny.ts
npx tsx packages/check/src/cloudflare-live-crud-tiny.ts
```

Use the usage token header for usage endpoints:

```text
x-living-atlas-usage-token: <raw usage token>
```

Expected results:

- unauthenticated usage calls are rejected
- usage token calls return the provider-neutral usage status/gate contract
- remote MCP and sync calls reject missing or mismatched authority ids
- tiny CRUD remains ciphertext/metadata-safe for sensitive synthetic objects
- audit events append without duplicate chain-head errors

## Rollback Boundary

The migration rebuilds `sync_batches` and `remote_graph_writes`. Restore from
the D1 backup if the migration is interrupted or if post-deploy smoke fails in a
way that cannot be explained by token/config mismatch.

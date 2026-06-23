-- Living Atlas security remediation migration.
--
-- This keeps existing synthetic D1 deployments aligned with the runtime schema:
-- - sync batch idempotency is unique per authority, not globally
-- - remote graph write idempotency is unique per authority, not globally
-- - audit event chains reject duplicate previous hashes per authority
--
-- Before applying to a D1 database that contains non-synthetic data, back it up
-- and run:
--
-- SELECT authority_ref, idempotency_key, COUNT(*) AS duplicate_count
-- FROM sync_batches
-- GROUP BY authority_ref, idempotency_key
-- HAVING duplicate_count > 1;
--
-- SELECT authority_ref, idempotency_key, COUNT(*) AS duplicate_count
-- FROM remote_graph_writes
-- GROUP BY authority_ref, idempotency_key
-- HAVING duplicate_count > 1;
--
-- Both queries must return zero rows. The earlier global uniqueness rules
-- normally make that true, but the preflight catches manually edited stores.

DROP TABLE IF EXISTS sync_batches_security_remediation;

CREATE TABLE sync_batches_security_remediation (
  batch_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  batch_hash TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  capability_ref TEXT NOT NULL,
  token_id TEXT,
  operation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  staged_at TEXT NOT NULL,
  committed_at TEXT,
  base_generation INTEGER NOT NULL,
  target_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'failed')),
  object_count INTEGER NOT NULL,
  change_count INTEGER NOT NULL,
  estimated_batch_bytes INTEGER NOT NULL,
  withheld_plaintext_count INTEGER NOT NULL,
  failure_reason TEXT,
  last_seen_at TEXT NOT NULL
);

INSERT INTO sync_batches_security_remediation (
  batch_id,
  idempotency_key,
  batch_hash,
  authority_ref,
  device_ref,
  client_ref,
  capability_ref,
  token_id,
  operation_id,
  trace_id,
  submitted_at,
  staged_at,
  committed_at,
  base_generation,
  target_generation,
  status,
  object_count,
  change_count,
  estimated_batch_bytes,
  withheld_plaintext_count,
  failure_reason,
  last_seen_at
)
SELECT
  batch_id,
  idempotency_key,
  batch_hash,
  authority_ref,
  device_ref,
  client_ref,
  capability_ref,
  token_id,
  operation_id,
  trace_id,
  submitted_at,
  staged_at,
  committed_at,
  base_generation,
  target_generation,
  status,
  object_count,
  change_count,
  estimated_batch_bytes,
  withheld_plaintext_count,
  failure_reason,
  last_seen_at
FROM sync_batches;

DROP TABLE sync_batches;
ALTER TABLE sync_batches_security_remediation RENAME TO sync_batches;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_batches_authority_idempotency_key
  ON sync_batches (authority_ref, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_sync_batches_committed_generation
  ON sync_batches (status, target_generation);

CREATE INDEX IF NOT EXISTS idx_sync_batches_authority_status_generation
  ON sync_batches (authority_ref, status, target_generation);

DROP TABLE IF EXISTS remote_graph_writes_security_remediation;

CREATE TABLE remote_graph_writes_security_remediation (
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  object_ref TEXT,
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'failed')),
  sync_batch_id TEXT,
  sync_generation INTEGER,
  response_json TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  last_seen_at TEXT NOT NULL
);

INSERT INTO remote_graph_writes_security_remediation (
  idempotency_key,
  request_hash,
  authority_ref,
  object_ref,
  operation,
  status,
  sync_batch_id,
  sync_generation,
  response_json,
  failure_reason,
  created_at,
  committed_at,
  last_seen_at
)
SELECT
  idempotency_key,
  request_hash,
  authority_ref,
  object_ref,
  operation,
  status,
  sync_batch_id,
  sync_generation,
  response_json,
  failure_reason,
  created_at,
  committed_at,
  last_seen_at
FROM remote_graph_writes;

DROP TABLE remote_graph_writes;
ALTER TABLE remote_graph_writes_security_remediation RENAME TO remote_graph_writes;

CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_graph_writes_authority_idempotency
  ON remote_graph_writes (authority_ref, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_remote_graph_writes_authority_status
  ON remote_graph_writes (authority_ref, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_authority_previous_hash
  ON audit_events (authority_ref, previous_event_hash);

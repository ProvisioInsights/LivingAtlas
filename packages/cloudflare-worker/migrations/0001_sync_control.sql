CREATE TABLE IF NOT EXISTS sync_batches (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_batches_authority_idempotency_key
  ON sync_batches (authority_ref, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_sync_batches_committed_generation
  ON sync_batches (status, target_generation);

CREATE INDEX IF NOT EXISTS idx_sync_batches_authority_status_generation
  ON sync_batches (authority_ref, status, target_generation);

CREATE TABLE IF NOT EXISTS sync_objects (
  object_ref TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  envelope_r2_key TEXT NOT NULL,
  ciphertext_r2_path_hash TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (object_ref, version)
);

CREATE INDEX IF NOT EXISTS idx_sync_objects_batch_id
  ON sync_objects (batch_id);

CREATE INDEX IF NOT EXISTS idx_sync_objects_authority_batch
  ON sync_objects (authority_ref, batch_id);

CREATE TABLE IF NOT EXISTS sync_changes (
  change_ref TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  operation TEXT NOT NULL,
  base_version INTEGER,
  new_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  actor_ref TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_batch_id
  ON sync_changes (batch_id);

CREATE INDEX IF NOT EXISTS idx_sync_changes_authority_generation
  ON sync_changes (authority_ref, generation);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  conflict_id TEXT PRIMARY KEY,
  authority_ref TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  base_generation INTEGER NOT NULL,
  local_generation INTEGER,
  remote_generation INTEGER,
  conflict_type TEXT NOT NULL,
  status TEXT NOT NULL,
  redacted_summary TEXT NOT NULL
);

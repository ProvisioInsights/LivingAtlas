CREATE TABLE IF NOT EXISTS remote_graph_writes (
  idempotency_key TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_remote_graph_writes_authority_status
  ON remote_graph_writes (authority_ref, status, created_at);

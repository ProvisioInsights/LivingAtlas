CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  authority_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  mcp_profile TEXT NOT NULL,
  operation TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('allowed', 'denied', 'withheld', 'released', 'changed')),
  reason_code TEXT,
  object_ref TEXT,
  release_ref TEXT,
  key_ref TEXT,
  capability_ref TEXT,
  sync_batch_ref TEXT,
  access_class TEXT,
  redaction TEXT NOT NULL CHECK (redaction IN ('remote-redacted', 'generic-unavailable')),
  summary TEXT NOT NULL,
  checkpoint_bucket TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE
);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE INDEX IF NOT EXISTS idx_audit_events_authority_recorded
  ON audit_events (authority_ref, recorded_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_operation
  ON audit_events (operation_id);

CREATE INDEX IF NOT EXISTS idx_audit_events_trace
  ON audit_events (trace_id);

CREATE INDEX IF NOT EXISTS idx_audit_events_type_recorded
  ON audit_events (event_type, recorded_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_recorded
  ON audit_events (actor_ref, recorded_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_object_recorded
  ON audit_events (object_ref, recorded_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_release_recorded
  ON audit_events (release_ref, recorded_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_key_recorded
  ON audit_events (key_ref, recorded_at);

CREATE TABLE IF NOT EXISTS operational_metrics (
  record_id TEXT PRIMARY KEY,
  signal_schema TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  plane TEXT NOT NULL,
  signal_kind TEXT NOT NULL,
  name TEXT,
  route TEXT,
  method TEXT,
  status INTEGER,
  duration_ms REAL,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  counters_json TEXT NOT NULL,
  redaction TEXT NOT NULL,
  sensitive INTEGER NOT NULL CHECK (sensitive = 0)
);

CREATE INDEX IF NOT EXISTS idx_operational_metrics_recorded_at
  ON operational_metrics (recorded_at);

CREATE INDEX IF NOT EXISTS idx_operational_metrics_expires_at
  ON operational_metrics (expires_at);

CREATE INDEX IF NOT EXISTS idx_operational_metrics_operation_id
  ON operational_metrics (operation_id);

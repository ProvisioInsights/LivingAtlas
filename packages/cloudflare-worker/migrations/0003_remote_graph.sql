CREATE TABLE IF NOT EXISTS remote_graph_objects (
  object_ref TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  version INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  access_class TEXT NOT NULL,
  envelope_r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
  edge_ref TEXT,
  source_ref TEXT,
  target_ref TEXT,
  predicate TEXT,
  valid_from TEXT,
  valid_to TEXT,
  timeline_start TEXT,
  timeline_end TEXT,
  search_text TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (object_ref, version)
);

CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_object
  ON remote_graph_objects (authority_ref, object_ref, version);

CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_updated
  ON remote_graph_objects (authority_ref, updated_at);

CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_type
  ON remote_graph_objects (authority_ref, object_type, updated_at);

CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_edge
  ON remote_graph_objects (authority_ref, edge_ref, version);

CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_source
  ON remote_graph_objects (authority_ref, source_ref, predicate);

CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_target
  ON remote_graph_objects (authority_ref, target_ref, predicate);

CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_timeline
  ON remote_graph_objects (authority_ref, timeline_start);

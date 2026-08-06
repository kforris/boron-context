-- Codex thread ownership is a retrieval index, not an ontology graph expansion.
-- Store privacy-safe thread-to-project observations with append-only provenance and
-- derive one current fail-closed state per client thread.

CREATE TABLE IF NOT EXISTS codex_thread_sync_snapshots (
  snapshot_id text PRIMARY KEY,
  client text NOT NULL,
  source text NOT NULL,
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (snapshot_id ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS codex_thread_project_observations (
  snapshot_id text NOT NULL REFERENCES codex_thread_sync_snapshots(snapshot_id) ON DELETE CASCADE,
  client text NOT NULL,
  external_thread_id text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  codex_project_id text,
  classification_state text NOT NULL
    CHECK (classification_state IN ('confirmed', 'candidate', 'projectless')),
  authority text NOT NULL
    CHECK (authority IN (
      'user_approved_plan',
      'codex_project_assignment',
      'exact_registered_root',
      'parent_inheritance',
      'candidate'
    )),
  authority_priority integer NOT NULL CHECK (authority_priority BETWEEN 0 AND 100),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_digest text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, client, external_thread_id),
  CHECK (evidence_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS codex_thread_observations_thread_idx
  ON codex_thread_project_observations (client, external_thread_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS codex_thread_observations_project_idx
  ON codex_thread_project_observations (project_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS codex_thread_project_state (
  client text NOT NULL,
  external_thread_id text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  codex_project_id text,
  classification_state text NOT NULL
    CHECK (classification_state IN ('confirmed', 'candidate', 'projectless', 'conflicted')),
  authority text NOT NULL,
  authority_priority integer NOT NULL CHECK (authority_priority BETWEEN 0 AND 100),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_digest text NOT NULL,
  source_snapshot_id text NOT NULL REFERENCES codex_thread_sync_snapshots(snapshot_id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, external_thread_id),
  CHECK (evidence_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS codex_thread_state_project_idx
  ON codex_thread_project_state (project_id, classification_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS codex_thread_state_health_idx
  ON codex_thread_project_state (classification_state, updated_at DESC);

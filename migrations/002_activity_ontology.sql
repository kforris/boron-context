CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_session_id text,
  client text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  intention_id uuid REFERENCES intentions(id) ON DELETE SET NULL,
  objective text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed', 'partial', 'cancelled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (client, external_session_id)
);

CREATE INDEX IF NOT EXISTS agent_sessions_project_started_idx
  ON agent_sessions (project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  activity_type text NOT NULL,
  actor_uri text,
  target_uri text,
  summary text NOT NULL,
  source text NOT NULL,
  idempotency_key text,
  confidence numeric(4,3) NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, idempotency_key)
);

CREATE INDEX IF NOT EXISTS activities_session_time_idx
  ON activities (session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activities_project_time_idx
  ON activities (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activities_type_time_idx
  ON activities (activity_type, occurred_at DESC);

ALTER TABLE relations
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to timestamptz,
  ADD COLUMN IF NOT EXISTS asserted_by_activity_id uuid REFERENCES activities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS relations_current_idx
  ON relations (source_object_id, relation_type, target_object_id)
  WHERE valid_to IS NULL AND confirmation_state <> 'rejected';

CREATE TABLE IF NOT EXISTS relation_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  source_object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  target_object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('assert', 'retract')),
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  confirmation_state text NOT NULL DEFAULT 'candidate'
    CHECK (confirmation_state IN ('candidate', 'confirmed', 'rejected')),
  effective_at timestamptz NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relation_effects_activity_idx
  ON relation_effects (activity_id);

CREATE OR REPLACE VIEW current_relations AS
SELECT
  r.id,
  r.source_object_id,
  r.relation_type,
  r.target_object_id,
  r.confidence,
  r.confirmation_state,
  r.provenance,
  r.valid_from,
  r.asserted_by_activity_id
FROM relations r
WHERE r.valid_to IS NULL
  AND r.confirmation_state <> 'rejected';

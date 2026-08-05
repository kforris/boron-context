-- Agent continuity health: observable MCP adoption, leased sessions, and coherent confirmed facts.
-- Historical rows remain in place; lifecycle and confirmation repairs are annotated with provenance.

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_duration_minutes integer,
  ADD COLUMN IF NOT EXISTS closure_reason text;

UPDATE agent_sessions
SET
  last_seen_at = coalesce(last_seen_at, ended_at, started_at),
  lease_duration_minutes = coalesce(lease_duration_minutes, 720),
  lease_expires_at = coalesce(
    lease_expires_at,
    coalesce(ended_at, started_at) + make_interval(mins => coalesce(lease_duration_minutes, 720))
  )
WHERE last_seen_at IS NULL
   OR lease_duration_minutes IS NULL
   OR lease_expires_at IS NULL;

ALTER TABLE agent_sessions
  ALTER COLUMN last_seen_at SET DEFAULT now(),
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN lease_duration_minutes SET DEFAULT 720,
  ALTER COLUMN lease_duration_minutes SET NOT NULL,
  ALTER COLUMN lease_expires_at SET DEFAULT (now() + interval '12 hours'),
  ALTER COLUMN lease_expires_at SET NOT NULL;

ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_lease_duration_minutes_check;
ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_lease_duration_minutes_check
  CHECK (lease_duration_minutes BETWEEN 15 AND 1440);

ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_client_external_session_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_active_external_idx
  ON agent_sessions (client, external_session_id)
  WHERE status = 'active' AND external_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_sessions_active_lease_idx
  ON agent_sessions (lease_expires_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS agent_client_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_instance_id text NOT NULL UNIQUE,
  client text NOT NULL,
  client_version text,
  protocol_version text,
  context_mode text NOT NULL DEFAULT 'none'
    CHECK (context_mode IN ('none', 'read', 'session')),
  session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  first_context_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS agent_client_observations_time_idx
  ON agent_client_observations (initialized_at DESC);
CREATE INDEX IF NOT EXISTS agent_client_observations_mode_time_idx
  ON agent_client_observations (context_mode, initialized_at DESC);

-- A confirmed relation confirms that both endpoint entities exist. This does not confirm unrelated
-- aliases or candidate relations. Preserve the previous state and the deterministic reason.
WITH confirmed_endpoints AS (
  SELECT source_object_id AS object_id
  FROM current_relations
  WHERE confirmation_state = 'confirmed'
    AND coalesce(provenance->>'modelProposed', 'false') = 'false'
  UNION
  SELECT target_object_id AS object_id
  FROM current_relations
  WHERE confirmation_state = 'confirmed'
    AND coalesce(provenance->>'modelProposed', 'false') = 'false'
)
UPDATE objects o
SET
  confirmation_state = 'confirmed',
  metadata = o.metadata || jsonb_build_object(
    'previousConfirmationState', o.confirmation_state,
    'confirmationAuthority', 'confirmed_relation_endpoint',
    'confirmationMigration', '007_agent_continuity_health'
  ),
  updated_at = now()
FROM confirmed_endpoints e
WHERE o.id = e.object_id
  AND o.confirmation_state = 'candidate';

UPDATE object_aliases a
SET
  confirmation_state = 'confirmed',
  metadata = a.metadata || jsonb_build_object(
    'confirmationAuthority', 'confirmed_object_name',
    'confirmationMigration', '007_agent_continuity_health'
  ),
  updated_at = now()
FROM objects o
WHERE a.object_id = o.id
  AND o.confirmation_state = 'confirmed'
  AND a.confirmation_state = 'candidate'
  AND a.normalized_alias = lower(trim(o.name));

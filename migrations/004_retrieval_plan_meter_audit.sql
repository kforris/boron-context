CREATE TABLE IF NOT EXISTS project_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  source_uri text,
  confirmation_state text NOT NULL DEFAULT 'candidate'
    CHECK (confirmation_state IN ('candidate', 'confirmed', 'rejected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS project_aliases_normalized_idx
  ON project_aliases (normalized_alias);

INSERT INTO project_aliases (
  project_id, alias, normalized_alias, source_uri, confirmation_state
)
SELECT
  id,
  name,
  lower(trim(name)),
  source_uri,
  CASE status WHEN 'confirmed' THEN 'confirmed' WHEN 'archived' THEN 'rejected' ELSE 'candidate' END
FROM projects
WHERE trim(name) <> ''
ON CONFLICT (project_id, normalized_alias) DO NOTHING;

CREATE TABLE IF NOT EXISTS object_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  source_uri text,
  confirmation_state text NOT NULL DEFAULT 'candidate'
    CHECK (confirmation_state IN ('candidate', 'confirmed', 'rejected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS object_aliases_normalized_idx
  ON object_aliases (normalized_alias);

INSERT INTO object_aliases (
  object_id, alias, normalized_alias, source_uri, confirmation_state
)
SELECT id, name, lower(trim(name)), canonical_uri, confirmation_state
FROM objects
WHERE trim(name) <> ''
ON CONFLICT (object_id, normalized_alias) DO NOTHING;

CREATE TABLE IF NOT EXISTS retrieval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  policy_type text NOT NULL,
  risk_class text NOT NULL DEFAULT 'all'
    CHECK (risk_class IN ('standard', 'high', 'all')),
  instruction text NOT NULL,
  source_uri text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  confirmation_state text NOT NULL DEFAULT 'candidate'
    CHECK (confirmation_state IN ('candidate', 'confirmed', 'rejected')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name, source_uri)
);

CREATE INDEX IF NOT EXISTS retrieval_policies_project_priority_idx
  ON retrieval_policies (project_id, status, priority DESC);

ALTER TABLE context_meter_samples
  ADD COLUMN IF NOT EXISTS re_explanation_evidence_count integer NOT NULL DEFAULT 0
    CHECK (re_explanation_evidence_count >= 0),
  ADD COLUMN IF NOT EXISTS re_explanation_avoided_tokens integer NOT NULL DEFAULT 0
    CHECK (re_explanation_avoided_tokens >= 0),
  ADD COLUMN IF NOT EXISTS source_window_status text NOT NULL DEFAULT 'not_covered'
    CHECK (source_window_status IN ('not_covered', 'measured_partial', 'measured_full')),
  ADD COLUMN IF NOT EXISTS source_window_selected_evidence_count integer NOT NULL DEFAULT 0
    CHECK (source_window_selected_evidence_count >= 0),
  ADD COLUMN IF NOT EXISTS source_window_covered_evidence_count integer NOT NULL DEFAULT 0
    CHECK (source_window_covered_evidence_count >= 0),
  ADD COLUMN IF NOT EXISTS source_window_original_tokens integer
    CHECK (source_window_original_tokens IS NULL OR source_window_original_tokens >= 0),
  ADD COLUMN IF NOT EXISTS source_window_capsule_tokens integer
    CHECK (source_window_capsule_tokens IS NULL OR source_window_capsule_tokens >= 0),
  ADD COLUMN IF NOT EXISTS source_window_savings_tokens integer
    CHECK (source_window_savings_tokens IS NULL OR source_window_savings_tokens >= 0),
  ADD COLUMN IF NOT EXISTS retrieval_plan jsonb NOT NULL DEFAULT '{
    "version": 1,
    "strategy": "ontology_first",
    "riskClass": "standard",
    "signals": ["legacy_sample"],
    "sourceAnchors": [],
    "stages": []
  }'::jsonb;

UPDATE context_meter_samples
SET
  re_explanation_avoided_tokens = recovered_context_tokens,
  source_window_status = CASE
    WHEN source_estimate_covered_evidence = 0 THEN 'not_covered'
    WHEN source_estimate_covered_evidence = selected_evidence_count THEN 'measured_full'
    ELSE 'measured_partial'
  END,
  source_window_selected_evidence_count = selected_evidence_count,
  source_window_covered_evidence_count = source_estimate_covered_evidence,
  source_window_original_tokens = CASE WHEN source_tokens > 0 THEN source_tokens ELSE NULL END,
  source_window_capsule_tokens = CASE
    WHEN source_estimate_covered_evidence > 0 THEN source_excerpt_tokens
    ELSE NULL
  END,
  source_window_savings_tokens = CASE
    WHEN source_estimate_covered_evidence > 0 THEN source_compression_tokens
    ELSE NULL
  END;

CREATE TABLE IF NOT EXISTS context_meter_evidence_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_sample_id uuid NOT NULL REFERENCES context_meter_samples(id) ON DELETE CASCADE,
  evidence_id text NOT NULL,
  layer text NOT NULL CHECK (layer IN ('ontology', 'codebase', 'wiki')),
  title text NOT NULL,
  uri text NOT NULL,
  adapter_name text NOT NULL,
  adapter_source_type text NOT NULL
    CHECK (adapter_source_type IN ('ontology', 'snapshot', 'live')),
  stage_id text NOT NULL,
  candidate_tokens integer NOT NULL CHECK (candidate_tokens >= 0),
  selected boolean NOT NULL,
  score numeric(8,7) NOT NULL CHECK (score BETWEEN 0 AND 1),
  source_token_estimate integer
    CHECK (source_token_estimate IS NULL OR source_token_estimate > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meter_sample_id, evidence_id, uri, stage_id, adapter_name)
);

CREATE INDEX IF NOT EXISTS context_meter_evidence_sample_idx
  ON context_meter_evidence_samples (meter_sample_id, selected DESC, score DESC);
CREATE INDEX IF NOT EXISTS context_meter_evidence_uri_idx
  ON context_meter_evidence_samples (uri, created_at DESC);

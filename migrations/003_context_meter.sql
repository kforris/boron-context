CREATE TABLE IF NOT EXISTS context_meter_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capsule_id uuid NOT NULL UNIQUE,
  trace_id uuid NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  client text NOT NULL,
  candidate_evidence_count integer NOT NULL CHECK (candidate_evidence_count >= 0),
  selected_evidence_count integer NOT NULL CHECK (selected_evidence_count >= 0),
  candidate_tokens integer NOT NULL CHECK (candidate_tokens >= 0),
  capsule_tokens integer NOT NULL CHECK (capsule_tokens >= 0),
  filtered_tokens integer NOT NULL CHECK (filtered_tokens >= 0),
  recovered_context_tokens integer NOT NULL CHECK (recovered_context_tokens >= 0),
  source_estimate_covered_evidence integer NOT NULL
    CHECK (source_estimate_covered_evidence >= 0),
  source_tokens integer NOT NULL CHECK (source_tokens >= 0),
  source_excerpt_tokens integer NOT NULL CHECK (source_excerpt_tokens >= 0),
  source_compression_tokens integer NOT NULL CHECK (source_compression_tokens >= 0),
  retrieval_latency_ms integer NOT NULL CHECK (retrieval_latency_ms >= 0),
  boron_llm_provider text NOT NULL DEFAULT 'none',
  boron_llm_model text NOT NULL DEFAULT 'none',
  boron_llm_calls integer NOT NULL DEFAULT 0 CHECK (boron_llm_calls >= 0),
  boron_llm_input_tokens integer NOT NULL DEFAULT 0
    CHECK (boron_llm_input_tokens >= 0),
  boron_llm_output_tokens integer NOT NULL DEFAULT 0
    CHECK (boron_llm_output_tokens >= 0),
  token_estimator text NOT NULL DEFAULT 'characters_divided_by_4',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_meter_project_created_idx
  ON context_meter_samples (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS context_meter_created_idx
  ON context_meter_samples (created_at DESC);

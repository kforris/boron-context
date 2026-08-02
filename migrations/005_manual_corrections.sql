CREATE TABLE IF NOT EXISTS manual_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  layer text NOT NULL CHECK (layer IN ('ontology', 'codebase', 'wiki')),
  subject_kind text NOT NULL,
  subject_id text,
  subject_uri text NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'dismissed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  resolution_summary text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS manual_corrections_project_status_idx
  ON manual_corrections (project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS manual_corrections_layer_status_idx
  ON manual_corrections (layer, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS manual_corrections_subject_idx
  ON manual_corrections (subject_uri, status, updated_at DESC);

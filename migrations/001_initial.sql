CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  name text NOT NULL,
  uri text NOT NULL UNIQUE,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source_uri text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'confirmed', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_name_lower_idx ON projects (lower(name));

CREATE TABLE IF NOT EXISTS objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  canonical_uri text NOT NULL UNIQUE,
  confirmation_state text NOT NULL DEFAULT 'candidate'
    CHECK (confirmation_state IN ('candidate', 'confirmed', 'rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  target_object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  confirmation_state text NOT NULL DEFAULT 'candidate'
    CHECK (confirmation_state IN ('candidate', 'confirmed', 'rejected')),
  provenance jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_object_id, relation_type, target_object_id, version)
);

CREATE TABLE IF NOT EXISTS intentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id uuid NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  objective text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  client text NOT NULL,
  status text NOT NULL DEFAULT 'captured'
    CHECK (status IN ('captured', 'resolved', 'needs_confirmation', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  layer text NOT NULL CHECK (layer IN ('ontology', 'codebase', 'wiki')),
  title text NOT NULL,
  uri text NOT NULL,
  excerpt text NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  authority numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (authority BETWEEN 0 AND 1),
  content_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(excerpt, ''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (layer, uri, content_hash)
);

CREATE INDEX IF NOT EXISTS evidence_search_idx ON evidence USING gin (search_document);
CREATE INDEX IF NOT EXISTS evidence_project_idx ON evidence (project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS context_capsules (
  id uuid PRIMARY KEY,
  trace_id uuid NOT NULL,
  intention_id uuid REFERENCES intentions(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  token_budget integer NOT NULL CHECK (token_budget > 0),
  estimated_tokens integer NOT NULL CHECK (estimated_tokens >= 0),
  truncated boolean NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  question text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'confirmed', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

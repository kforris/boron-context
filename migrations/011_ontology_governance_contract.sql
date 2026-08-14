-- Ontology governance contract v1.
--
-- Existing ontology rows are labelled as contract v0 and their observed vocabulary is registered
-- as legacy. New activity writeback uses contract v1, validates every entity kind and relation
-- type against this registry, and records an auditable decision without rewriting historical facts.

ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS ontology_contract_version smallint NOT NULL DEFAULT 0;
ALTER TABLE objects
  DROP CONSTRAINT IF EXISTS objects_ontology_contract_check;
ALTER TABLE objects
  ADD CONSTRAINT objects_ontology_contract_check
  CHECK (ontology_contract_version BETWEEN 0 AND 32767);

ALTER TABLE relations
  ADD COLUMN IF NOT EXISTS ontology_contract_version smallint NOT NULL DEFAULT 0;
ALTER TABLE relations
  DROP CONSTRAINT IF EXISTS relations_ontology_contract_check;
ALTER TABLE relations
  ADD CONSTRAINT relations_ontology_contract_check
  CHECK (ontology_contract_version BETWEEN 0 AND 32767);

ALTER TABLE relation_effects
  ADD COLUMN IF NOT EXISTS ontology_contract_version smallint NOT NULL DEFAULT 0;
ALTER TABLE relation_effects
  DROP CONSTRAINT IF EXISTS relation_effects_ontology_contract_check;
ALTER TABLE relation_effects
  ADD CONSTRAINT relation_effects_ontology_contract_check
  CHECK (ontology_contract_version BETWEEN 0 AND 32767);

CREATE TABLE IF NOT EXISTS ontology_type_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version smallint NOT NULL DEFAULT 1 CHECK (contract_version > 0),
  type_family text NOT NULL CHECK (type_family IN ('entity_kind', 'relation_type')),
  type_name text NOT NULL CHECK (length(trim(type_name)) > 0),
  status text NOT NULL CHECK (status IN ('active', 'legacy', 'deprecated')),
  replacement_type text,
  owner text NOT NULL,
  source_authority text NOT NULL
    CHECK (source_authority IN ('system', 'operator', 'migration')),
  source_uri text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type_family, type_name)
);

INSERT INTO ontology_type_registry (
  type_family, type_name, status, owner, source_authority, source_uri, metadata
)
SELECT DISTINCT
  'entity_kind', kind, 'legacy', 'legacy-data', 'migration',
  'boron://migration/011_ontology_governance_contract',
  '{"classification":"observed_before_contract_v1"}'::jsonb
FROM objects
WHERE trim(kind) <> ''
ON CONFLICT (type_family, type_name) DO NOTHING;

INSERT INTO ontology_type_registry (
  type_family, type_name, status, owner, source_authority, source_uri, metadata
)
SELECT DISTINCT
  'relation_type', relation_type, 'legacy', 'legacy-data', 'migration',
  'boron://migration/011_ontology_governance_contract',
  '{"classification":"observed_before_contract_v1"}'::jsonb
FROM relations
WHERE trim(relation_type) <> ''
ON CONFLICT (type_family, type_name) DO NOTHING;

INSERT INTO ontology_type_registry (
  type_family, type_name, status, owner, source_authority, source_uri, metadata
)
VALUES
  ('entity_kind', 'Project', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/Project', '{}'),
  ('entity_kind', 'project', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/project', '{}'),
  ('entity_kind', 'Service', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/Service', '{}'),
  ('entity_kind', 'service', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/service', '{}'),
  ('entity_kind', 'Artifact', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/Artifact', '{}'),
  ('entity_kind', 'Capability', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/Capability', '{}'),
  ('entity_kind', 'Policy', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/Policy', '{}'),
  ('entity_kind', 'Agent', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/Agent', '{}'),
  ('entity_kind', 'HumanRole', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/HumanRole', '{}'),
  ('entity_kind', 'Automation', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/Automation', '{}'),
  ('entity_kind', 'CodeIndex', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/CodeIndex', '{}'),
  ('entity_kind', 'project_group', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/project_group', '{}'),
  ('entity_kind', 'project_scope', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/project_scope', '{}'),
  ('entity_kind', 'local_root', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/local_root', '{}'),
  ('entity_kind', 'repository', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/repository', '{}'),
  ('entity_kind', 'release', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/release', '{}'),
  ('entity_kind', 'pull_request', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/pull_request', '{}'),
  ('entity_kind', 'issue', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/issue', '{}'),
  ('entity_kind', 'document', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/document', '{}'),
  ('entity_kind', 'workflow', 'active', 'boron-context', 'system', 'boron://ontology/v1/entity/workflow', '{}'),
  ('relation_type', 'HAS_REGISTERED_ROOT', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/HAS_REGISTERED_ROOT', '{}'),
  ('relation_type', 'HAS_REGISTERED_WORKSPACE', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/HAS_REGISTERED_WORKSPACE', '{}'),
  ('relation_type', 'MAY_INCLUDE_WORKSPACE', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/MAY_INCLUDE_WORKSPACE', '{}'),
  ('relation_type', 'INDEXED_AS', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/INDEXED_AS', '{}'),
  ('relation_type', 'SUPERSEDES', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/SUPERSEDES', '{}'),
  ('relation_type', 'USES', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/USES', '{}'),
  ('relation_type', 'DEPENDS_ON', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/DEPENDS_ON', '{}'),
  ('relation_type', 'IMPLEMENTS', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/IMPLEMENTS', '{}'),
  ('relation_type', 'PRODUCES', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/PRODUCES', '{}'),
  ('relation_type', 'GOVERNED_BY', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/GOVERNED_BY', '{}'),
  ('relation_type', 'VERIFIES', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/VERIFIES', '{}'),
  ('relation_type', 'RELATED_TO', 'active', 'boron-context', 'system', 'boron://ontology/v1/relation/RELATED_TO', '{}')
ON CONFLICT (type_family, type_name)
DO UPDATE SET
  contract_version = EXCLUDED.contract_version,
  status = EXCLUDED.status,
  replacement_type = EXCLUDED.replacement_type,
  owner = EXCLUDED.owner,
  source_authority = EXCLUDED.source_authority,
  source_uri = EXCLUDED.source_uri,
  metadata = ontology_type_registry.metadata || EXCLUDED.metadata,
  updated_at = now();

CREATE TABLE IF NOT EXISTS ontology_governance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version smallint NOT NULL DEFAULT 1 CHECK (contract_version > 0),
  session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  activity_id uuid REFERENCES activities(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'deprecated')),
  reason text NOT NULL,
  type_family text CHECK (type_family IN ('entity_kind', 'relation_type', 'relation_rule')),
  type_name text,
  registry_status text CHECK (registry_status IN ('active', 'legacy', 'deprecated')),
  relation_authority text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ontology_governance_events_time_idx
  ON ontology_governance_events (created_at DESC);
CREATE INDEX IF NOT EXISTS ontology_governance_events_project_time_idx
  ON ontology_governance_events (project_id, created_at DESC);

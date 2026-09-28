-- Explicit source-backed PR state vocabulary; no historical facts are rewritten.
INSERT INTO ontology_type_registry (
  type_family, type_name, status, owner, source_authority, source_uri, metadata
)
SELECT 'relation_type', name, 'active', 'boron-context', 'system',
       'boron://ontology/v1/relation/' || name,
       '{"stateFamily":"github_pull_request","sourceRequired":true}'::jsonb
FROM unnest(ARRAY['GITHUB_PR_OPEN', 'GITHUB_PR_CLOSED', 'GITHUB_PR_MERGED']) AS name
ON CONFLICT (type_family, type_name) DO NOTHING;

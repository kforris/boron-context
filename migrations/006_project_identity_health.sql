-- Canonical project identities are globally unique while historical aliases remain revisionable.
-- Existing aliases are not deleted or silently reclassified by this schema migration.
CREATE UNIQUE INDEX IF NOT EXISTS project_aliases_confirmed_identity_idx
  ON project_aliases (normalized_alias)
  WHERE confirmation_state = 'confirmed'
    AND metadata @> '{"identity": true}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS projects_codex_project_id_idx
  ON projects ((metadata ->> 'codexProjectId'))
  WHERE metadata ? 'codexProjectId';

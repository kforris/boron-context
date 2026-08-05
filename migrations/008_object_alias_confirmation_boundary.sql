-- Repair the overly broad alias backfill from the first local application of migration 007.
-- Only the alias matching a confirmed object's canonical name is deterministic. Other aliases
-- retain their candidate state until an authoritative source or explicit user approval confirms them.

UPDATE object_aliases a
SET
  confirmation_state = 'candidate',
  metadata = a.metadata || jsonb_build_object(
    'confirmationCorrection', 'noncanonical_alias_requires_review',
    'confirmationCorrectionMigration', '008_object_alias_confirmation_boundary',
    'confirmationCorrectedAt', now()
  ),
  updated_at = now()
FROM objects o
WHERE a.object_id = o.id
  AND a.confirmation_state = 'confirmed'
  AND a.metadata->>'confirmationMigration' = '007_agent_continuity_health'
  AND a.normalized_alias <> lower(trim(o.name));

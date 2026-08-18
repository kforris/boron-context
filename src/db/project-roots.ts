import type { Pool, PoolClient } from 'pg'

export async function loadRegisteredProjectRoots(
  database: Pool | PoolClient,
  projectId: string | null
): Promise<readonly string[]> {
  if (!projectId) return []
  const result = await database.query<{ path: string }>(
    `
      SELECT DISTINCT root.metadata->>'path' AS path
      FROM objects owner
      JOIN relations relation ON relation.source_object_id = owner.id
      JOIN objects root ON root.id = relation.target_object_id
      WHERE owner.project_id = $1::uuid
        AND lower(owner.kind) IN ('project', 'project_group')
        AND owner.confirmation_state = 'confirmed'
        AND relation.relation_type = 'HAS_REGISTERED_ROOT'
        AND relation.confirmation_state = 'confirmed'
        AND relation.valid_to IS NULL
        AND root.kind = 'local_root'
        AND root.confirmation_state = 'confirmed'
        AND jsonb_typeof(root.metadata->'path') = 'string'
      ORDER BY path
    `,
    [projectId]
  )
  return result.rows.map((row) => row.path)
}

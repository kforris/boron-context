import type { Pool, PoolClient } from 'pg'
import type { ResolvedProject } from '../core/contracts.js'

interface ProjectIdentityRow {
  readonly id: string
  readonly name: string
  readonly priority: number
  readonly peer_count: number
}

/**
 * Resolve only authoritative, exact project identities.
 *
 * Historical aliases are intentionally lower priority than aliases marked as the
 * project's canonical identity. If the best available tier has more than one
 * owner, resolution fails closed instead of selecting by row order.
 */
export async function resolveProjectIdentity(
  pool: Pool | PoolClient,
  hint: string | undefined
): Promise<ResolvedProject | null> {
  if (!hint) return null
  const result = await pool.query<ProjectIdentityRow>(
    `
      WITH candidates AS (
        SELECT
          p.id,
          p.name,
          min(
            CASE
              WHEN p.source_uri = $1 THEN 0
              WHEN a.confirmation_state = 'confirmed'
                AND a.metadata @> '{"identity": true}'::jsonb
                AND a.normalized_alias = lower(trim($1)) THEN 1
              WHEN lower(trim(p.name)) = lower(trim($1)) THEN 2
              WHEN a.confirmation_state = 'confirmed'
                AND a.normalized_alias = lower(trim($1)) THEN 3
              ELSE 99
            END
          )::integer AS priority
        FROM projects p
        LEFT JOIN project_aliases a ON a.project_id = p.id
        WHERE p.status = 'confirmed'
          AND (
            p.source_uri = $1
            OR lower(trim(p.name)) = lower(trim($1))
            OR (
              a.confirmation_state = 'confirmed'
              AND a.normalized_alias = lower(trim($1))
            )
          )
        GROUP BY p.id, p.name
      ), ranked AS (
        SELECT
          id,
          name,
          priority,
          count(*) OVER (PARTITION BY priority)::integer AS peer_count
        FROM candidates
        WHERE priority < 99
      )
      SELECT id::text, name, priority, peer_count
      FROM ranked
      ORDER BY priority, lower(name), id
      LIMIT 2
    `,
    [hint]
  )
  return selectResolvedProject(result.rows)
}

export function selectResolvedProject(rows: readonly ProjectIdentityRow[]): ResolvedProject | null {
  const first = rows[0]
  if (!first || first.peer_count !== 1) return null
  return {
    id: first.id,
    name: first.name,
    confidence: confidenceForPriority(first.priority)
  }
}

function confidenceForPriority(priority: number): number {
  switch (priority) {
    case 0:
      return 1
    case 1:
      return 0.99
    case 2:
      return 0.95
    default:
      return 0.9
  }
}

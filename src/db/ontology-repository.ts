import type { Pool } from 'pg'
import type { ContextAdapter, AdapterSearchInput } from '../core/context-adapter.js'
import type { Evidence, ResolveContextRequest, ResolvedProject } from '../core/contracts.js'
import type { ProjectResolver } from '../core/resolver.js'

export class PostgresOntologyRepository implements ContextAdapter, ProjectResolver {
  readonly layer = 'ontology' as const
  readonly name = 'PostgreSQL ontology'

  constructor(private readonly pool: Pool) {}

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      await this.pool.query('SELECT 1')
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  async resolve(request: ResolveContextRequest): Promise<ResolvedProject | null> {
    if (!request.projectHint) return null
    const result = await this.pool.query<{ id: string; name: string; similarity: number }>(
      `
        SELECT id::text, name,
          CASE
            WHEN lower(name) = lower($1) THEN 1.0
            WHEN source_uri = $1 THEN 0.98
            WHEN lower(name) LIKE '%' || lower($1) || '%' THEN 0.75
            ELSE 0.5
          END AS similarity
        FROM projects
        WHERE lower(name) = lower($1)
           OR source_uri = $1
           OR lower(name) LIKE '%' || lower($1) || '%'
        ORDER BY similarity DESC, name ASC
        LIMIT 2
      `,
      [request.projectHint]
    )
    const first = result.rows[0]
    const second = result.rows[1]
    if (!first || (second && first.similarity - second.similarity < 0.1)) return null
    return { id: first.id, name: first.name, confidence: Number(first.similarity) }
  }

  async search(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    const result = await this.pool.query<{
      id: string
      title: string
      uri: string
      excerpt: string
      confidence: number
      authority: number
      updated_at: Date
      content_hash: string | null
      project_id: string | null
    }>(
      `
        SELECT
          e.id::text,
          e.title,
          e.uri,
          e.excerpt,
          e.confidence,
          e.authority,
          e.updated_at,
          e.content_hash,
          e.project_id::text
        FROM evidence e
        WHERE ($1::uuid IS NULL OR e.project_id = $1::uuid)
          AND (
            e.search_document @@ websearch_to_tsquery('simple', $2)
            OR lower(e.title) LIKE '%' || lower($2) || '%'
          )
        ORDER BY
          ts_rank_cd(e.search_document, websearch_to_tsquery('simple', $2)) DESC,
          e.confidence DESC,
          e.updated_at DESC
        LIMIT $3
      `,
      [input.projectId, input.request.objective, input.limit]
    )
    return result.rows.map((row) => ({
      id: row.id,
      layer: 'ontology',
      title: row.title,
      uri: row.uri,
      excerpt: row.excerpt,
      confidence: Number(row.confidence),
      authority: Number(row.authority),
      updatedAt: row.updated_at.toISOString(),
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      metadata: {}
    }))
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

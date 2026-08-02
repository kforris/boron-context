import type { Pool } from 'pg'
import type { ContextAdapter, AdapterSearchInput } from '../core/context-adapter.js'
import type {
  ContextLayer,
  Evidence,
  ResolveContextRequest,
  ResolvedProject
} from '../core/contracts.js'
import type { ProjectResolver } from '../core/resolver.js'

export class PostgresOntologyRepository implements ContextAdapter, ProjectResolver {
  readonly layer = 'ontology' as const
  readonly name = 'PostgreSQL ontology'
  readonly sourceType = 'ontology' as const

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
        WITH candidates AS (
          SELECT
            p.id,
            p.name,
            max(
              CASE
                WHEN p.source_uri = $1 THEN 1.0
                WHEN lower(p.name) = lower($1) THEN 0.99
                WHEN lower(a.alias) = lower($1) THEN 0.97
                WHEN lower(p.name) LIKE '%' || lower($1) || '%' THEN 0.75
                WHEN lower(a.alias) LIKE '%' || lower($1) || '%' THEN 0.72
                ELSE 0.5
              END
            ) AS similarity
          FROM projects p
          LEFT JOIN project_aliases a ON a.project_id = p.id
          WHERE p.source_uri = $1
             OR lower(p.name) = lower($1)
             OR lower(a.alias) = lower($1)
             OR lower(p.name) LIKE '%' || lower($1) || '%'
             OR lower(a.alias) LIKE '%' || lower($1) || '%'
          GROUP BY p.id, p.name
        )
        SELECT id::text, name, similarity
        FROM candidates
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
    if (input.purpose === 'policy') return this.searchPolicies(input, true)
    const [stored, structure, policies] = await Promise.all([
      this.searchLayer('ontology', input),
      this.searchOntologyStructure(input),
      this.searchPolicies(input, false)
    ])
    const corrections = stored.filter((item) => item.metadata.manualCorrection === true)
    const remainingStored = stored.filter((item) => item.metadata.manualCorrection !== true)
    return [...corrections, ...structure, ...policies, ...remainingStored].slice(0, input.limit)
  }

  async searchLayer(layer: ContextLayer, input: AdapterSearchInput): Promise<readonly Evidence[]> {
    const [result, corrections] = await Promise.all([
      this.pool.query<{
        id: string
        layer: ContextLayer
        title: string
        uri: string
        excerpt: string
        confidence: number
        authority: number
        updated_at: Date
        content_hash: string | null
        project_id: string | null
        metadata: Record<string, unknown>
      }>(
        `
        SELECT
          e.id::text,
          e.layer,
          e.title,
          e.uri,
          e.excerpt,
          e.confidence,
          e.authority,
          e.updated_at,
          e.content_hash,
          e.project_id::text,
          e.metadata
        FROM evidence e
        WHERE e.layer = $4
          AND (
            (
              $1::uuid IS NOT NULL
              AND e.project_id = $1::uuid
            ) OR (
              $1::uuid IS NULL
              AND (
                e.search_document @@ websearch_to_tsquery('simple', $2)
                OR lower(e.title) LIKE '%' || lower($2) || '%'
              )
            )
          )
        ORDER BY
          CASE WHEN e.uri = ANY($5::text[]) THEN 1 ELSE 0 END DESC,
          ts_rank_cd(e.search_document, websearch_to_tsquery('simple', $2)) DESC,
          e.confidence DESC,
          e.updated_at DESC
        LIMIT $3
        `,
        [input.projectId, searchText(input), input.limit, layer, input.sourceAnchors]
      ),
      this.searchManualCorrections(layer, input)
    ])
    const stored = result.rows.map((row) => ({
      id: row.id,
      layer: row.layer,
      title: row.title,
      uri: row.uri,
      excerpt: row.excerpt,
      confidence: Number(row.confidence),
      authority: Number(row.authority),
      updatedAt: row.updated_at.toISOString(),
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      metadata: row.metadata
    }))
    return [...corrections, ...stored].slice(0, input.limit)
  }

  private async searchManualCorrections(
    layer: ContextLayer,
    input: AdapterSearchInput
  ): Promise<readonly Evidence[]> {
    const result = await this.pool.query<{
      id: string
      project_id: string | null
      subject_kind: string
      subject_id: string | null
      subject_uri: string
      fields: Record<string, string>
      note: string
      revision: number
      updated_at: Date
    }>(
      `
        SELECT
          id::text,
          project_id::text,
          subject_kind,
          subject_id,
          subject_uri,
          fields,
          note,
          revision,
          updated_at
        FROM manual_corrections
        WHERE status = 'pending'
          AND layer = $1
          AND (
            ($2::uuid IS NOT NULL AND project_id = $2::uuid)
            OR (
              $2::uuid IS NULL
              AND (
                lower(subject_uri) LIKE '%' || lower($3) || '%'
                OR lower(note) LIKE '%' || lower($3) || '%'
                OR fields::text ILIKE '%' || $3 || '%'
              )
            )
          )
        ORDER BY updated_at DESC
        LIMIT $4
      `,
      [layer, input.projectId, searchText(input), input.limit]
    )
    return result.rows.map((row) => {
      const fields = Object.entries(row.fields)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')
      const detail = [fields ? `fields: ${fields}` : '', row.note ? `note: ${row.note}` : '']
        .filter(Boolean)
        .join('. ')
      return {
        id: `manual-correction-${row.id}`,
        layer,
        title: `Human correction pending: ${row.subject_uri}`,
        uri: `boron://manual-correction/${row.id}`,
        excerpt: `A human reviewer requested a correction for ${row.subject_uri}. ${detail}`,
        confidence: 1,
        authority: 1,
        updatedAt: row.updated_at.toISOString(),
        ...(row.project_id ? { projectId: row.project_id } : {}),
        metadata: {
          manualCorrection: true,
          correctionId: row.id,
          status: 'pending',
          revision: row.revision,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          subjectUri: row.subject_uri,
          fields: row.fields
        }
      }
    })
  }

  private async searchOntologyStructure(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    if (!input.projectId) return []
    const projectId = input.projectId
    const loweredHints = input.request.objectHints.map((hint) => hint.toLowerCase())
    const [project, objects, relations] = await Promise.all([
      this.pool.query<{
        id: string
        name: string
        source_uri: string
        status: string
        aliases: string[]
        updated_at: Date
      }>(
        `
          SELECT
            p.id::text,
            p.name,
            p.source_uri,
            p.status,
            coalesce(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}')
              AS aliases,
            p.updated_at
          FROM projects p
          LEFT JOIN project_aliases a ON a.project_id = p.id
          WHERE p.id = $1::uuid
          GROUP BY p.id
        `,
        [projectId]
      ),
      this.pool.query<{
        id: string
        kind: string
        name: string
        canonical_uri: string
        confirmation_state: string
        version: number
        aliases: string[]
        updated_at: Date
      }>(
        `
          SELECT
            o.id::text,
            o.kind,
            o.name,
            o.canonical_uri,
            o.confirmation_state,
            o.version,
            coalesce(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}')
              AS aliases,
            o.updated_at
          FROM objects o
          LEFT JOIN object_aliases a ON a.object_id = o.id
          WHERE o.project_id = $1::uuid
            AND o.confirmation_state <> 'rejected'
          GROUP BY o.id
          ORDER BY
            CASE
              WHEN cardinality($2::text[]) = 0 THEN 1
              WHEN lower(o.name) = ANY($2::text[]) THEN 0
              WHEN EXISTS (
                SELECT 1 FROM object_aliases oa
                WHERE oa.object_id = o.id AND lower(oa.alias) = ANY($2::text[])
              ) THEN 0
              ELSE 2
            END,
            o.updated_at DESC
          LIMIT $3
        `,
        [projectId, loweredHints, Math.min(12, input.limit)]
      ),
      this.pool.query<{
        id: string
        source_name: string
        source_uri: string
        relation_type: string
        target_name: string
        target_uri: string
        confidence: number
        confirmation_state: string
        valid_from: Date
      }>(
        `
          SELECT
            r.id::text,
            source.name AS source_name,
            source.canonical_uri AS source_uri,
            r.relation_type,
            target.name AS target_name,
            target.canonical_uri AS target_uri,
            r.confidence,
            r.confirmation_state,
            r.valid_from
          FROM current_relations r
          JOIN objects source ON source.id = r.source_object_id
          JOIN objects target ON target.id = r.target_object_id
          WHERE source.project_id = $1::uuid OR target.project_id = $1::uuid
          ORDER BY
            CASE WHEN r.confirmation_state = 'confirmed' THEN 0 ELSE 1 END,
            r.valid_from DESC
          LIMIT $2
        `,
        [projectId, Math.min(12, input.limit)]
      )
    ])

    const projectEvidence: Evidence[] = project.rows.map((row) => ({
      id: `project-${row.id}`,
      layer: 'ontology',
      title: `Project scope: ${row.name}`,
      uri: row.source_uri,
      excerpt: `Confirmed project scope ${row.name}; aliases: ${row.aliases.join(', ') || 'none'}.`,
      confidence: row.status === 'confirmed' ? 1 : 0.7,
      authority: 1,
      updatedAt: row.updated_at.toISOString(),
      projectId: row.id,
      metadata: { ontologyKind: 'project', aliases: row.aliases, status: row.status }
    }))
    const objectEvidence: Evidence[] = objects.rows.map((row) => ({
      id: row.id,
      layer: 'ontology',
      title: `${row.kind}: ${row.name}`,
      uri: row.canonical_uri,
      excerpt: `${row.name} is a ${row.confirmation_state} ${row.kind}; aliases: ${row.aliases.join(', ') || 'none'}.`,
      confidence: row.confirmation_state === 'confirmed' ? 1 : 0.7,
      authority: 0.9,
      updatedAt: row.updated_at.toISOString(),
      projectId,
      metadata: {
        ontologyKind: 'entity',
        aliases: row.aliases,
        confirmationState: row.confirmation_state,
        version: row.version
      }
    }))
    const relationEvidence: Evidence[] = relations.rows.map((row) => ({
      id: row.id,
      layer: 'ontology',
      title: `${row.source_name} ${row.relation_type} ${row.target_name}`,
      uri: `boron://relation/${row.id}`,
      excerpt: `${row.source_uri} ${row.relation_type} ${row.target_uri}.`,
      confidence: Number(row.confidence),
      authority: row.confirmation_state === 'confirmed' ? 1 : 0.7,
      updatedAt: row.valid_from.toISOString(),
      projectId,
      metadata: {
        ontologyKind: 'relation',
        confirmationState: row.confirmation_state,
        sourceUri: row.source_uri,
        targetUri: row.target_uri
      }
    }))
    return [...projectEvidence, ...objectEvidence, ...relationEvidence]
  }

  private async searchPolicies(
    input: AdapterSearchInput,
    includeInstruction: boolean
  ): Promise<readonly Evidence[]> {
    if (!input.projectId) return []
    const projectId = input.projectId
    const result = await this.pool.query<{
      id: string
      name: string
      policy_type: string
      risk_class: string
      instruction: string
      source_uri: string
      confirmation_state: string
      priority: number
      updated_at: Date
    }>(
      `
        SELECT
          id::text,
          name,
          policy_type,
          risk_class,
          instruction,
          source_uri,
          confirmation_state,
          priority,
          updated_at
        FROM retrieval_policies
        WHERE project_id = $1::uuid
          AND status = 'active'
          AND confirmation_state <> 'rejected'
          AND (
            $2::boolean = false
            OR (risk_class IN ('high', 'all') AND confirmation_state = 'confirmed')
          )
        ORDER BY
          CASE WHEN confirmation_state = 'confirmed' THEN 0 ELSE 1 END,
          priority DESC,
          updated_at DESC
        LIMIT $3
      `,
      [projectId, includeInstruction, Math.min(10, input.limit)]
    )
    return result.rows.map((row) => ({
      id: row.id,
      layer: 'ontology',
      title: `Policy: ${row.name}`,
      uri: row.source_uri,
      excerpt: includeInstruction
        ? row.instruction
        : `${row.policy_type} policy reference (${row.risk_class} risk).`,
      confidence: row.confirmation_state === 'confirmed' ? 1 : 0.65,
      authority: row.confirmation_state === 'confirmed' ? 1 : 0.7,
      updatedAt: row.updated_at.toISOString(),
      projectId,
      metadata: {
        ontologyKind: 'policy',
        policyType: row.policy_type,
        riskClass: row.risk_class,
        confirmationState: row.confirmation_state,
        priority: row.priority
      }
    }))
  }
}

export class PostgresLayerEvidenceAdapter implements ContextAdapter {
  readonly name: string
  readonly sourceType = 'snapshot' as const

  constructor(
    private readonly repository: PostgresOntologyRepository,
    readonly layer: ContextLayer
  ) {
    this.name =
      layer === 'ontology'
        ? 'PostgreSQL ontology'
        : `PostgreSQL ${layer} evidence snapshots (local, not live)`
  }

  health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return this.repository.health()
  }

  search(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    return this.repository.searchLayer(this.layer, input)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function searchText(input: AdapterSearchInput): string {
  return [
    input.request.objective,
    input.request.projectHint ?? '',
    ...input.request.objectHints,
    ...input.sourceAnchors
  ]
    .filter(Boolean)
    .join(' ')
}

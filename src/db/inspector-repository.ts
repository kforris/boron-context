import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import type { Pool } from 'pg'
import type {
  ContextLayer,
  InspectorScope,
  ListManualCorrectionsInput,
  ManualCorrectionInput,
  ResolveManualCorrectionInput
} from '../core/contracts.js'
import { resolveProjectIdentity } from './project-identity.js'

const MAX_GRAPH_NODES = 500
const MAX_GRAPH_EDGES = 1_000
const MAX_WIKI_PAGES = 200
const MAX_WIKI_PAGE_BYTES = 256 * 1024
const MAX_WIKI_TOTAL_BYTES = 2 * 1024 * 1024

export interface ManualCorrectionRecord {
  readonly id: string
  readonly projectId: string | null
  readonly projectName: string | null
  readonly layer: ContextLayer
  readonly subjectKind: string
  readonly subjectId: string | null
  readonly subjectUri: string
  readonly fields: Record<string, string>
  readonly note: string
  readonly status: 'pending' | 'resolved' | 'dismissed'
  readonly revision: number
  readonly resolutionSummary: string | null
  readonly resolvedBy: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly resolvedAt: string | null
}

export class PostgresInspectorRepository {
  constructor(
    private readonly pool: Pool,
    private readonly wikiRoot: string
  ) {}

  async ontologyGraph(input: InspectorScope): Promise<{
    readonly project: { readonly id: string; readonly name: string } | null
    readonly projects: readonly {
      readonly id: string
      readonly name: string
      readonly sourceUri: string
      readonly status: string
    }[]
    readonly nodes: readonly {
      readonly id: string
      readonly projectId: string | null
      readonly kind: string
      readonly name: string
      readonly canonicalUri: string
      readonly confirmationState: string
      readonly version: number
      readonly updatedAt: string
    }[]
    readonly edges: readonly {
      readonly id: string
      readonly source: string
      readonly target: string
      readonly relationType: string
      readonly confidence: number
      readonly confirmationState: string
      readonly validFrom: string
    }[]
    readonly pendingCorrections: readonly ManualCorrectionRecord[]
  }> {
    const project = await resolveProjectIdentity(this.pool, input.projectHint)
    const projectId = project?.id ?? null
    const projectScopeRequested = input.projectHint !== undefined
    const [projects, nodes, edges, pendingCorrections] = await Promise.all([
      this.pool.query<{
        id: string
        name: string
        source_uri: string
        status: string
      }>(
        `
          SELECT id::text, name, source_uri, status
          FROM projects
          ORDER BY
            CASE WHEN id = $1::uuid THEN 0 ELSE 1 END,
            name
        `,
        [projectId]
      ),
      this.pool.query<{
        id: string
        project_id: string | null
        kind: string
        name: string
        canonical_uri: string
        confirmation_state: string
        version: number
        updated_at: Date
      }>(
        `
          SELECT
            id::text,
            project_id::text,
            kind,
            name,
            canonical_uri,
            confirmation_state,
            version,
            updated_at
          FROM objects
          WHERE confirmation_state <> 'rejected'
            AND (
              NOT $3::boolean
              OR project_id = $1::uuid
              OR id IN (
                SELECT r.target_object_id
                FROM current_relations r
                JOIN objects source ON source.id = r.source_object_id
                WHERE source.project_id = $1::uuid
                UNION
                SELECT r.source_object_id
                FROM current_relations r
                JOIN objects target ON target.id = r.target_object_id
                WHERE target.project_id = $1::uuid
              )
            )
          ORDER BY confirmation_state, kind, name
          LIMIT $2
        `,
        [projectId, MAX_GRAPH_NODES, projectScopeRequested]
      ),
      this.pool.query<{
        id: string
        source_object_id: string
        target_object_id: string
        relation_type: string
        confidence: number
        confirmation_state: string
        valid_from: Date
      }>(
        `
          SELECT
            r.id::text,
            r.source_object_id::text,
            r.target_object_id::text,
            r.relation_type,
            r.confidence,
            r.confirmation_state,
            r.valid_from
          FROM current_relations r
          JOIN objects source ON source.id = r.source_object_id
          JOIN objects target ON target.id = r.target_object_id
          WHERE NOT $3::boolean
             OR source.project_id = $1::uuid
             OR target.project_id = $1::uuid
          ORDER BY r.confirmation_state, r.relation_type, r.valid_from DESC
          LIMIT $2
        `,
        [projectId, MAX_GRAPH_EDGES, projectScopeRequested]
      ),
      this.listCorrections({
        ...(input.projectHint ? { projectHint: input.projectHint } : {}),
        status: 'pending',
        limit: 200
      })
    ])
    return {
      project,
      projects: projects.rows.map((row) => ({
        id: row.id,
        name: row.name,
        sourceUri: row.source_uri,
        status: row.status
      })),
      nodes: nodes.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        kind: row.kind,
        name: row.name,
        canonicalUri: row.canonical_uri,
        confirmationState: row.confirmation_state,
        version: row.version,
        updatedAt: row.updated_at.toISOString()
      })),
      edges: edges.rows.map((row) => ({
        id: row.id,
        source: row.source_object_id,
        target: row.target_object_id,
        relationType: row.relation_type,
        confidence: Number(row.confidence),
        confirmationState: row.confirmation_state,
        validFrom: row.valid_from.toISOString()
      })),
      pendingCorrections
    }
  }

  async listCorrections(
    input: ListManualCorrectionsInput
  ): Promise<readonly ManualCorrectionRecord[]> {
    const project = await resolveProjectIdentity(this.pool, input.projectHint)
    const projectScopeRequested = input.projectHint !== undefined
    const result = await this.pool.query<ManualCorrectionRow>(
      `
        SELECT
          c.id::text,
          c.project_id::text,
          p.name AS project_name,
          c.layer,
          c.subject_kind,
          c.subject_id,
          c.subject_uri,
          c.fields,
          c.note,
          c.status,
          c.revision,
          c.resolution_summary,
          c.resolved_by,
          c.created_at,
          c.updated_at,
          c.resolved_at
        FROM manual_corrections c
        LEFT JOIN projects p ON p.id = c.project_id
        WHERE c.status = $1
          AND (NOT $5::boolean OR c.project_id = $2::uuid)
          AND ($3::text IS NULL OR c.layer = $3)
        ORDER BY c.updated_at DESC
        LIMIT $4
      `,
      [input.status, project?.id ?? null, input.layer ?? null, input.limit, projectScopeRequested]
    )
    return result.rows.map(mapCorrection)
  }

  async createCorrection(input: ManualCorrectionInput): Promise<ManualCorrectionRecord> {
    if (Object.keys(input.fields).length === 0 && input.note.length === 0) {
      throw new Error('A manual correction requires at least one changed field or a note')
    }
    const project = await resolveProjectIdentity(this.pool, input.projectHint)
    if (input.projectHint && !project) {
      throw new Error(`Project could not be resolved: ${input.projectHint}`)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `
          UPDATE manual_corrections
          SET
            status = 'dismissed',
            resolution_summary = 'Superseded by a newer human correction.',
            resolved_by = 'human.inspector',
            resolved_at = now(),
            updated_at = now()
          WHERE status = 'pending'
            AND layer = $1
            AND subject_uri = $2
            AND project_id IS NOT DISTINCT FROM $3::uuid
        `,
        [input.layer, input.subjectUri, project?.id ?? null]
      )
      const inserted = await client.query<ManualCorrectionRow>(
        `
          INSERT INTO manual_corrections (
            project_id,
            layer,
            subject_kind,
            subject_id,
            subject_uri,
            fields,
            note,
            revision
          )
          VALUES (
            $1::uuid,
            $2,
            $3,
            $4,
            $5,
            $6::jsonb,
            $7,
            coalesce((
              SELECT max(revision) + 1
              FROM manual_corrections
              WHERE layer = $2
                AND subject_uri = $5
                AND project_id IS NOT DISTINCT FROM $1::uuid
            ), 1)
          )
          RETURNING
            id::text,
            project_id::text,
            $8::text AS project_name,
            layer,
            subject_kind,
            subject_id,
            subject_uri,
            fields,
            note,
            status,
            revision,
            resolution_summary,
            resolved_by,
            created_at,
            updated_at,
            resolved_at
        `,
        [
          project?.id ?? null,
          input.layer,
          input.subjectKind,
          input.subjectId ?? null,
          input.subjectUri,
          JSON.stringify(input.fields),
          input.note,
          project?.name ?? null
        ]
      )
      await client.query('COMMIT')
      return mapCorrection(inserted.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async resolveCorrection(
    input: ResolveManualCorrectionInput
  ): Promise<ManualCorrectionRecord | null> {
    const result = await this.pool.query<ManualCorrectionRow>(
      `
        UPDATE manual_corrections c
        SET
          status = $2,
          resolution_summary = $3,
          resolved_by = $4,
          resolved_at = now(),
          updated_at = now()
        WHERE c.id = $1::uuid
          AND c.status = 'pending'
        RETURNING
          c.id::text,
          c.project_id::text,
          (SELECT p.name FROM projects p WHERE p.id = c.project_id) AS project_name,
          c.layer,
          c.subject_kind,
          c.subject_id,
          c.subject_uri,
          c.fields,
          c.note,
          c.status,
          c.revision,
          c.resolution_summary,
          c.resolved_by,
          c.created_at,
          c.updated_at,
          c.resolved_at
      `,
      [input.correctionId, input.outcome, input.summary, input.resolvedBy]
    )
    return result.rows[0] ? mapCorrection(result.rows[0]) : null
  }

  async wiki(): Promise<{
    readonly root: string
    readonly pages: readonly {
      readonly path: string
      readonly title: string
      readonly uri: string
      readonly content: string
      readonly updatedAt: string
    }[]
  }> {
    let root: string
    try {
      root = await realpath(this.wikiRoot)
    } catch {
      return { root: this.wikiRoot, pages: [] }
    }
    const paths = await markdownFiles(root)
    const pages: {
      path: string
      title: string
      uri: string
      content: string
      updatedAt: string
    }[] = []
    let totalBytes = 0
    for (const path of paths.slice(0, MAX_WIKI_PAGES)) {
      const file = await readFile(path)
      if (file.byteLength > MAX_WIKI_PAGE_BYTES) continue
      if (totalBytes + file.byteLength > MAX_WIKI_TOTAL_BYTES) break
      totalBytes += file.byteLength
      const content = file.toString('utf8')
      const info = await stat(path)
      const relativePath = relative(root, path).split(sep).join('/')
      pages.push({
        path: relativePath,
        title: markdownTitle(content, relativePath),
        uri: `openwiki://${relativePath}`,
        content,
        updatedAt: info.mtime.toISOString()
      })
    }
    return { root, pages }
  }
}

interface ManualCorrectionRow {
  readonly id: string
  readonly project_id: string | null
  readonly project_name: string | null
  readonly layer: ContextLayer
  readonly subject_kind: string
  readonly subject_id: string | null
  readonly subject_uri: string
  readonly fields: Record<string, string>
  readonly note: string
  readonly status: 'pending' | 'resolved' | 'dismissed'
  readonly revision: number
  readonly resolution_summary: string | null
  readonly resolved_by: string | null
  readonly created_at: Date
  readonly updated_at: Date
  readonly resolved_at: Date | null
}

function mapCorrection(row: ManualCorrectionRow): ManualCorrectionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    layer: row.layer,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectUri: row.subject_uri,
    fields: row.fields,
    note: row.note,
    status: row.status,
    revision: row.revision,
    resolutionSummary: row.resolution_summary,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null
  }
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= MAX_WIKI_PAGES) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
      if (files.length >= MAX_WIKI_PAGES) return
    }
  }
  await walk(root, 0)
  return files
}

function markdownTitle(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || basename(path, '.md').replaceAll('-', ' ')
}

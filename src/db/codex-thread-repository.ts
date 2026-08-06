import type { Pool } from 'pg'
import type {
  CodexThreadProjectObservation,
  CodexThreadSyncAuthority,
  CodexThreadSyncRequest
} from '../core/contracts.js'

export interface CodexThreadSyncResult {
  readonly snapshotId: string
  readonly duplicate: boolean
  readonly received: number
  readonly confirmed: number
  readonly candidate: number
  readonly projectless: number
  readonly unresolvedProjects: number
}

export interface CodexThreadSyncHealth {
  readonly snapshots: number
  readonly totalThreads: number
  readonly confirmedThreads: number
  readonly candidateThreads: number
  readonly projectlessThreads: number
  readonly conflictedThreads: number
  readonly lastSnapshotAt: string | null
}

interface ProjectIdentityRow {
  readonly id: string
  readonly codex_project_id: string
}

interface StoredObservation {
  readonly externalThreadId: string
  readonly projectId: string | null
  readonly codexProjectId: string | null
  readonly classificationState: 'confirmed' | 'candidate' | 'projectless'
  readonly authority: CodexThreadSyncAuthority
  readonly authorityPriority: number
  readonly confidence: number
  readonly evidenceDigest: string
  readonly metadata: Record<string, unknown>
}

export class PostgresCodexThreadRepository {
  constructor(private readonly pool: Pool) {}

  async sync(input: CodexThreadSyncRequest): Promise<CodexThreadSyncResult> {
    assertUniqueThreads(input.observations)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const snapshot = await client.query<{ snapshot_id: string }>(
        `
          INSERT INTO codex_thread_sync_snapshots (
            snapshot_id, client, source, observation_count, metadata, observed_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
          ON CONFLICT (snapshot_id) DO NOTHING
          RETURNING snapshot_id
        `,
        [
          input.snapshotId,
          input.client,
          input.source,
          input.observations.length,
          JSON.stringify(input.metadata),
          input.observedAt
        ]
      )
      if (!snapshot.rows[0]) {
        await client.query('ROLLBACK')
        return summarize(input.snapshotId, input.observations, true, 0)
      }

      const codexProjectIds = [
        ...new Set(
          input.observations.flatMap((item) => (item.codexProjectId ? [item.codexProjectId] : []))
        )
      ]
      const projects =
        codexProjectIds.length === 0
          ? { rows: [] as ProjectIdentityRow[] }
          : await client.query<ProjectIdentityRow>(
              `
                SELECT id::text, metadata->>'codexProjectId' AS codex_project_id
                FROM projects
                WHERE status = 'confirmed'
                  AND metadata->>'codexProjectId' = ANY($1::text[])
                UNION ALL
                SELECT id::text, substr(source_uri, length('codex-project://') + 1)
                FROM projects
                WHERE status = 'confirmed'
                  AND source_uri = ANY($2::text[])
                  AND NOT (metadata ? 'codexProjectId')
              `,
              [codexProjectIds, codexProjectIds.map((id) => `codex-project://${id}`)]
            )
      const projectIds = uniqueProjectIdentities(projects.rows)
      let unresolvedProjects = 0
      const stored = input.observations.map<StoredObservation>((item) => {
        const projectId = item.codexProjectId ? (projectIds.get(item.codexProjectId) ?? null) : null
        const unresolved = item.classificationState === 'confirmed' && !projectId
        if (unresolved) unresolvedProjects += 1
        return {
          externalThreadId: item.externalThreadId,
          projectId,
          codexProjectId: item.codexProjectId ?? null,
          classificationState: unresolved ? 'candidate' : item.classificationState,
          authority: item.authority,
          authorityPriority: authorityPriority(item.authority),
          confidence: item.confidence,
          evidenceDigest: item.evidenceDigest,
          metadata: {
            ...item.metadata,
            ...(unresolved ? { unresolvedCodexProjectId: item.codexProjectId } : {})
          }
        }
      })
      const payload = JSON.stringify(
        stored.map((item) => ({
          external_thread_id: item.externalThreadId,
          project_id: item.projectId,
          codex_project_id: item.codexProjectId,
          classification_state: item.classificationState,
          authority: item.authority,
          authority_priority: item.authorityPriority,
          confidence: item.confidence,
          evidence_digest: item.evidenceDigest,
          metadata: item.metadata
        }))
      )
      await client.query(
        `
          INSERT INTO codex_thread_project_observations (
            snapshot_id, client, external_thread_id, project_id, codex_project_id,
            classification_state, authority, authority_priority, confidence,
            evidence_digest, metadata, observed_at
          )
          SELECT
            $1,
            $2,
            input.external_thread_id,
            input.project_id::uuid,
            input.codex_project_id,
            input.classification_state,
            input.authority,
            input.authority_priority,
            input.confidence,
            input.evidence_digest,
            input.metadata,
            $4::timestamptz
          FROM jsonb_to_recordset($3::jsonb) AS input(
            external_thread_id text,
            project_id text,
            codex_project_id text,
            classification_state text,
            authority text,
            authority_priority integer,
            confidence numeric,
            evidence_digest text,
            metadata jsonb
          )
        `,
        [input.snapshotId, input.client, payload, input.observedAt]
      )
      await client.query(
        `
          INSERT INTO codex_thread_project_state (
            client, external_thread_id, project_id, codex_project_id,
            classification_state, authority, authority_priority, confidence,
            evidence_digest, source_snapshot_id, metadata,
            first_observed_at, last_observed_at
          )
          SELECT
            $1,
            input.external_thread_id,
            input.project_id::uuid,
            input.codex_project_id,
            input.classification_state,
            input.authority,
            input.authority_priority,
            input.confidence,
            input.evidence_digest,
            $2,
            input.metadata,
            $4::timestamptz,
            $4::timestamptz
          FROM jsonb_to_recordset($3::jsonb) AS input(
            external_thread_id text,
            project_id text,
            codex_project_id text,
            classification_state text,
            authority text,
            authority_priority integer,
            confidence numeric,
            evidence_digest text,
            metadata jsonb
          )
          ON CONFLICT (client, external_thread_id) DO UPDATE SET
            project_id = CASE
              WHEN EXCLUDED.authority_priority > codex_thread_project_state.authority_priority
                THEN EXCLUDED.project_id
              WHEN EXCLUDED.authority_priority < codex_thread_project_state.authority_priority
                THEN codex_thread_project_state.project_id
              WHEN codex_thread_project_state.codex_project_id IS DISTINCT FROM EXCLUDED.codex_project_id
                OR (codex_thread_project_state.classification_state = 'projectless')
                  <> (EXCLUDED.classification_state = 'projectless')
                THEN NULL
              ELSE EXCLUDED.project_id
            END,
            codex_project_id = CASE
              WHEN EXCLUDED.authority_priority > codex_thread_project_state.authority_priority
                THEN EXCLUDED.codex_project_id
              WHEN EXCLUDED.authority_priority < codex_thread_project_state.authority_priority
                THEN codex_thread_project_state.codex_project_id
              WHEN codex_thread_project_state.codex_project_id IS DISTINCT FROM EXCLUDED.codex_project_id
                OR (codex_thread_project_state.classification_state = 'projectless')
                  <> (EXCLUDED.classification_state = 'projectless')
                THEN NULL
              ELSE EXCLUDED.codex_project_id
            END,
            classification_state = CASE
              WHEN EXCLUDED.authority_priority > codex_thread_project_state.authority_priority
                THEN EXCLUDED.classification_state
              WHEN EXCLUDED.authority_priority < codex_thread_project_state.authority_priority
                THEN codex_thread_project_state.classification_state
              WHEN codex_thread_project_state.codex_project_id IS DISTINCT FROM EXCLUDED.codex_project_id
                OR (codex_thread_project_state.classification_state = 'projectless')
                  <> (EXCLUDED.classification_state = 'projectless')
                THEN 'conflicted'
              ELSE EXCLUDED.classification_state
            END,
            authority = CASE
              WHEN EXCLUDED.authority_priority >= codex_thread_project_state.authority_priority
                THEN EXCLUDED.authority
              ELSE codex_thread_project_state.authority
            END,
            authority_priority = greatest(
              codex_thread_project_state.authority_priority,
              EXCLUDED.authority_priority
            ),
            confidence = CASE
              WHEN EXCLUDED.authority_priority >= codex_thread_project_state.authority_priority
                THEN EXCLUDED.confidence
              ELSE codex_thread_project_state.confidence
            END,
            evidence_digest = CASE
              WHEN EXCLUDED.authority_priority >= codex_thread_project_state.authority_priority
                THEN EXCLUDED.evidence_digest
              ELSE codex_thread_project_state.evidence_digest
            END,
            source_snapshot_id = CASE
              WHEN EXCLUDED.authority_priority >= codex_thread_project_state.authority_priority
                THEN EXCLUDED.source_snapshot_id
              ELSE codex_thread_project_state.source_snapshot_id
            END,
            metadata = codex_thread_project_state.metadata || EXCLUDED.metadata,
            last_observed_at = greatest(
              codex_thread_project_state.last_observed_at,
              EXCLUDED.last_observed_at
            ),
            updated_at = now()
        `,
        [input.client, input.snapshotId, payload, input.observedAt]
      )
      await client.query('COMMIT')
      return summarize(input.snapshotId, stored, false, unresolvedProjects)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async health(): Promise<CodexThreadSyncHealth> {
    const result = await this.pool.query<{
      snapshots: number
      total_threads: number
      confirmed_threads: number
      candidate_threads: number
      projectless_threads: number
      conflicted_threads: number
      last_snapshot_at: Date | null
    }>(`
      SELECT
        (SELECT count(*)::integer FROM codex_thread_sync_snapshots) AS snapshots,
        count(*)::integer AS total_threads,
        count(*) FILTER (WHERE classification_state = 'confirmed')::integer AS confirmed_threads,
        count(*) FILTER (WHERE classification_state = 'candidate')::integer AS candidate_threads,
        count(*) FILTER (WHERE classification_state = 'projectless')::integer AS projectless_threads,
        count(*) FILTER (WHERE classification_state = 'conflicted')::integer AS conflicted_threads,
        (SELECT max(observed_at) FROM codex_thread_sync_snapshots) AS last_snapshot_at
      FROM codex_thread_project_state
    `)
    const row = result.rows[0]!
    return {
      snapshots: row.snapshots,
      totalThreads: row.total_threads,
      confirmedThreads: row.confirmed_threads,
      candidateThreads: row.candidate_threads,
      projectlessThreads: row.projectless_threads,
      conflictedThreads: row.conflicted_threads,
      lastSnapshotAt: row.last_snapshot_at?.toISOString() ?? null
    }
  }
}

function authorityPriority(authority: CodexThreadSyncAuthority): number {
  switch (authority) {
    case 'user_approved_plan':
      return 100
    case 'codex_project_assignment':
      return 90
    case 'exact_registered_root':
      return 80
    case 'parent_inheritance':
      return 70
    default:
      return 40
  }
}

function assertUniqueThreads(observations: readonly CodexThreadProjectObservation[]): void {
  const seen = new Set<string>()
  for (const observation of observations) {
    if (seen.has(observation.externalThreadId)) {
      throw new Error(`Duplicate thread observation: ${observation.externalThreadId}`)
    }
    seen.add(observation.externalThreadId)
  }
}

function uniqueProjectIdentities(rows: readonly ProjectIdentityRow[]): Map<string, string> {
  const candidates = new Map<string, string[]>()
  for (const row of rows) {
    const values = candidates.get(row.codex_project_id) ?? []
    values.push(row.id)
    candidates.set(row.codex_project_id, values)
  }
  return new Map(
    [...candidates.entries()].flatMap(([codexProjectId, ids]) =>
      new Set(ids).size === 1 ? [[codexProjectId, ids[0]!] as const] : []
    )
  )
}

function summarize(
  snapshotId: string,
  observations: readonly Pick<StoredObservation, 'classificationState'>[],
  duplicate: boolean,
  unresolvedProjects: number
): CodexThreadSyncResult {
  return {
    snapshotId,
    duplicate,
    received: observations.length,
    confirmed: observations.filter((item) => item.classificationState === 'confirmed').length,
    candidate: observations.filter((item) => item.classificationState === 'candidate').length,
    projectless: observations.filter((item) => item.classificationState === 'projectless').length,
    unresolvedProjects
  }
}

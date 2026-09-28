import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { RecordActivityRequest } from '../core/contracts.js'
import { ContinuityConflictError, ProjectScopeError } from '../core/errors.js'

// Registry reconciliation, project supersession and activity writes share this lock.
// The low-volume semantic write path is serialized; reads remain concurrent.
export async function lockOntologyWrites(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('boron-ontology-write'))")
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

export function activityRequestDigest(input: RecordActivityRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex')
}

// Check before relation governance: a successful retry may contain a now-inactive retraction.
export async function findActivityRetry(
  client: PoolClient,
  input: RecordActivityRequest,
  source: string,
  digest: string
): Promise<string | null> {
  if (!input.idempotencyKey) return null
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `activity:${source}:${input.idempotencyKey}`
  ])
  const prior = await client.query<{ id: string; session_id: string; digest: string | null }>(
    `SELECT id::text, session_id::text, payload->>'requestDigest' AS digest
     FROM activities WHERE source = $1 AND idempotency_key = $2`,
    [source, input.idempotencyKey]
  )
  const row = prior.rows[0]
  if (!row) return null
  if (row.session_id !== input.sessionId || row.digest !== digest) {
    throw new ContinuityConflictError('idempotency_conflict')
  }
  return row.id
}

export async function verifyRelationPreconditions(
  client: PoolClient,
  input: RecordActivityRequest,
  projectId: string | null
): Promise<void> {
  const preconditions = input.relationPreconditions ?? []
  const subjects = [
    ...new Set([
      ...input.relationEffects.map((effect) => effect.subject.canonicalUri),
      ...preconditions.map((condition) => condition.subjectUri)
    ])
  ].sort()
  // Every write takes these locks, including ordinary record_activity and session completion.
  for (const uri of subjects) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`relation:${uri}`])
  }
  for (const condition of preconditions) {
    const subject = await client.query<{ id: string; project_id: string | null }>(
      'SELECT id::text, project_id::text FROM objects WHERE canonical_uri = $1',
      [condition.subjectUri]
    )
    if (!projectId || subject.rows[0]?.project_id !== projectId) {
      throw new ProjectScopeError(
        'project_mismatch',
        'Relation precondition must belong to the session project.'
      )
    }
    const result = await client.query<{ id: string }>(
      `SELECT id::text FROM current_relations
       WHERE source_object_id = $1::uuid AND relation_type = ANY($2::text[]) ORDER BY id`,
      [subject.rows[0].id, condition.relationTypes]
    )
    const actual = result.rows.map((row) => row.id).sort()
    const expected = [...new Set(condition.expectedRelationIds)].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new ContinuityConflictError('relation_precondition_failed')
    }
  }
}

export async function validateContextUse(
  client: PoolClient,
  input: RecordActivityRequest,
  projectId: string | null
): Promise<Record<string, unknown> | null> {
  if (!input.contextUse && input.activityType !== 'context.used') return null
  if (
    !input.contextUse ||
    input.activityType !== 'context.used' ||
    !input.projectHint ||
    input.evidence.length === 0 ||
    input.evidence.some((item) => !item.uri)
  ) {
    throw new ContinuityConflictError('invalid_context_use')
  }
  const use = input.contextUse
  const sample = await client.query<{ id: string; project_id: string | null }>(
    'SELECT id::text, project_id::text FROM context_meter_samples WHERE capsule_id = $1::uuid',
    [use.capsuleId]
  )
  if (!projectId || sample.rows[0]?.project_id !== projectId) {
    throw new ContinuityConflictError('invalid_context_use')
  }
  const selected = await client.query<{ evidence_id: string; uri: string }>(
    `SELECT DISTINCT evidence_id, uri FROM context_meter_evidence_samples
     WHERE meter_sample_id = $1::uuid AND selected AND evidence_id = ANY($2::text[])`,
    [sample.rows[0].id, use.evidenceIds]
  )
  const ids = [...new Set(use.evidenceIds)].sort()
  if (
    ids.length !== use.evidenceIds.length ||
    selected.rows.length !== ids.length ||
    ids.some((id) => !selected.rows.some((row) => row.evidence_id === id))
  ) {
    throw new ContinuityConflictError('invalid_context_use')
  }
  return {
    contractVersion: 1,
    capsuleId: use.capsuleId,
    evidenceIds: ids,
    selectedEvidence: selected.rows.sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)),
    disposition: use.disposition,
    basis: 'client_report_with_validated_selection',
    caveat:
      'Selection and project scope are verified. Adoption and outcome are client-reported, not independent proof of task quality.'
  }
}

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  ActivityEvidenceInput,
  CompleteSessionRequest,
  RecordActivityRequest,
  RecordContextUseRequest,
  RelationEffect
} from '../src/core/contracts.js'
import type { ContextAdapter } from '../src/core/context-adapter.js'
import { ContextResolver } from '../src/core/resolver.js'
import { PostgresActivityRepository } from '../src/db/activity-repository.js'
import { PostgresOntologyRepository } from '../src/db/ontology-repository.js'
import { reconcileCodexRegistry, type CodexRegistry } from '../src/db/project-registry.js'
import { reconcileProjectSupersessions } from '../src/db/project-supersession.js'
import { acquirePostgresTestLock } from './postgres-test-lock.js'

const databaseUrl = process.env.BORON_TEST_DATABASE_URL
const describeDatabase = databaseUrl ? describe : describe.skip

describeDatabase('PostgreSQL trusted continuity integration', () => {
  const applicationName = `trusted-continuity-${randomUUID()}`
  let pool: Pool
  let repository: PostgresActivityRepository
  let releaseTestLock: (() => Promise<void>) | undefined

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, application_name: applicationName })
    releaseTestLock = await acquirePostgresTestLock(pool)
    repository = new PostgresActivityRepository(pool)
  })

  afterAll(async () => {
    try {
      await releaseTestLock?.()
    } finally {
      await pool?.end()
    }
  })

  async function fixture() {
    const suffix = randomUUID()
    const name = `Trusted continuity ${suffix}`
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, source_uri, status, metadata)
       VALUES ($1, $2, 'confirmed', '{"integrationTest":true}'::jsonb) RETURNING id::text`,
      [name, `integration://trusted-continuity/${suffix}`]
    )
    const id = project.rows[0]!.id
    return { id, name, suffix, session: await startSession(name) }
  }

  async function startSession(projectHint: string) {
    return repository.startSession({
      objective: 'Verify trusted continuity in a disposable database',
      projectHint,
      externalSessionId: `trusted-continuity-${randomUUID()}`,
      client: 'trusted-continuity-integration-test',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  function activity(
    context: Fixture,
    overrides: Partial<RecordActivityRequest> = {}
  ): RecordActivityRequest {
    return {
      sessionId: context.session.id,
      projectHint: context.name,
      activityType: 'integration.trusted_continuity',
      summary: 'A verified fixture outcome.',
      idempotencyKey: `trusted-continuity-${randomUUID()}`,
      confidence: 1,
      metadata: { integrationTest: true },
      relationEffects: [],
      evidence: [],
      ...overrides
    }
  }

  async function relationFixture() {
    const context = await fixture()
    const relation: RelationEffect = {
      subject: {
        kind: 'Artifact',
        name: 'Fixture subject',
        canonicalUri: `integration://trusted-subject/${context.suffix}`
      },
      relationType: 'VERIFIES',
      target: {
        kind: 'Artifact',
        name: 'Original fixture target',
        canonicalUri: `integration://trusted-target/${context.suffix}/original`
      },
      operation: 'assert',
      confidence: 1,
      confirmationState: 'confirmed',
      authority: 'deterministic_source',
      rationale: 'A deterministic integration fixture.'
    }
    await repository.recordActivity(activity(context, { relationEffects: [relation] }))
    const row = await pool.query<{ id: string }>(
      `SELECT r.id::text FROM current_relations r
       JOIN objects subject ON subject.id = r.source_object_id
       WHERE subject.canonical_uri = $1 AND r.relation_type = $2`,
      [relation.subject.canonicalUri, relation.relationType]
    )
    expect(row.rows).toHaveLength(1)
    return { ...context, relation, relationId: row.rows[0]!.id }
  }

  type RelationFixture = Awaited<ReturnType<typeof relationFixture>>

  function replacement(context: RelationFixture, name: string): RecordActivityRequest {
    return activity(context, {
      relationPreconditions: [
        {
          subjectUri: context.relation.subject.canonicalUri,
          relationTypes: [context.relation.relationType],
          expectedRelationIds: [context.relationId]
        }
      ],
      relationEffects: [
        { ...context.relation, operation: 'retract' },
        {
          ...context.relation,
          target: {
            kind: 'Artifact',
            name,
            canonicalUri: `integration://trusted-target/${context.suffix}/${name}`
          }
        }
      ]
    })
  }

  async function projectRows(projectId: string) {
    const result = await pool.query<Record<string, number>>(
      `SELECT
         (SELECT count(*)::int FROM activities WHERE project_id = $1::uuid) AS activities,
         (SELECT count(*)::int FROM evidence WHERE project_id = $1::uuid) AS evidence,
         (SELECT count(*)::int FROM objects WHERE project_id = $1::uuid) AS objects,
         (SELECT count(*)::int FROM relations r JOIN objects o ON o.id = r.source_object_id
          WHERE o.project_id = $1::uuid) AS relations,
         (SELECT count(*)::int FROM relation_effects e JOIN activities a ON a.id = e.activity_id
          WHERE a.project_id = $1::uuid) AS relation_effects,
         (SELECT count(*)::int FROM ontology_governance_events WHERE project_id = $1::uuid) AS governance`,
      [projectId]
    )
    return result.rows[0]!
  }

  async function expectBlockedWriters(holdingPid: number, expected: number) {
    let waiting = 0
    for (let attempt = 0; attempt < 200 && waiting < expected; attempt += 1) {
      const result = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_locks waiting
         JOIN pg_locks held ON held.pid = $1 AND held.locktype = 'advisory'
           AND waiting.locktype = held.locktype AND waiting.database = held.database
           AND waiting.classid = held.classid AND waiting.objid = held.objid
           AND waiting.objsubid = held.objsubid
         JOIN pg_stat_activity activity ON activity.pid = waiting.pid
         WHERE NOT waiting.granted AND activity.application_name = $2`,
        [holdingPid, applicationName]
      )
      waiting = result.rows[0]!.count
      if (waiting < expected) await delay(10)
    }
    expect(waiting).toBe(expected)
  }

  it('keeps old source observations historical after a typed current state is reconciled', async () => {
    const context = await relationFixture()
    const sourceUri = context.relation.subject.canonicalUri
    const oldText = 'PR remains open and mergeable; maintainer re-review is required.'
    const sourceEvidence = (excerpt: string): ActivityEvidenceInput => ({
      layer: 'ontology',
      title: 'Source status',
      uri: sourceUri,
      excerpt,
      confidence: 1,
      authority: 1,
      metadata: { sourceAuthority: 'deterministic_source' }
    })
    const open = { ...context.relation, relationType: 'GITHUB_PR_OPEN' }
    await repository.recordActivity(
      activity(context, {
        targetUri: 'codex://automation/fixture',
        occurredAt: '2026-08-04T00:00:00.000Z',
        relationEffects: [open],
        evidence: [sourceEvidence(oldText)]
      })
    )
    const recorded = await repository.recordActivity(
      activity(context, {
        targetUri: sourceUri,
        relationEffects: [
          { ...open, operation: 'retract' },
          { ...open, relationType: 'GITHUB_PR_MERGED' }
        ],
        evidence: [sourceEvidence('GitHub state is MERGED.')]
      })
    )
    const ontology = new PostgresOntologyRepository(pool)
    const resolver = new ContextResolver({ adapters: [ontology], projects: ontology })
    const request = {
      projectHint: context.name,
      objectHints: [sourceUri],
      layers: ['ontology'],
      tokenBudget: 6000
    }
    const capsule = await resolver.resolve({
      ...request,
      objective: '核对当前PR状态，历史状态不能作为当前待办。'
    })
    const old = capsule.evidence.find((item) => item.excerpt.includes(oldText))!
    const current = capsule.evidence.find((item) =>
      item.excerpt.includes('GitHub state is MERGED.')
    )!
    expect(old.metadata.temporalContext).toMatchObject({
      role: 'activity_observation',
      asOf: '2026-08-04T00:00:00.000Z',
      subjectUri: sourceUri,
      currentStateRefs: [{ relationType: 'GITHUB_PR_MERGED' }]
    })
    expect(old.excerpt).toContain('not proof of current state')
    expect(current.metadata.temporalContext).toMatchObject({
      role: 'current_state_source',
      activityId: recorded.id
    })
    expect(current.score).toBeGreaterThan(old.score)
    const historical = await resolver.resolve({
      ...request,
      objective: 'Explain the historical PR status timeline.'
    })
    expect(historical.evidence.find((item) => item.id === old.id)?.excerpt).toContain(oldText)
    const stored = await pool.query<{ excerpt: string }>(
      'SELECT excerpt FROM evidence WHERE id = $1::uuid',
      [old.id]
    )
    expect(stored.rows[0]?.excerpt).toBe(oldText)
  })

  it('accepts the exact retry after its retraction and precondition are no longer current', async () => {
    const context = await relationFixture()
    const request = replacement(context, 'replacement')
    const recorded = await repository.recordActivity(request)
    const afterWrite = await projectRows(context.id)
    const retried = await repository.recordActivity(request)
    expect(retried).toMatchObject({
      id: recorded.id,
      duplicate: true,
      relationEffects: 0,
      evidence: 0
    })
    expect(await projectRows(context.id)).toEqual(afterWrite)
    const oldRelation = await pool.query<{ valid_to: Date | null }>(
      'SELECT valid_to FROM relations WHERE id = $1::uuid',
      [context.relationId]
    )
    expect(oldRelation.rows[0]!.valid_to).not.toBeNull()
  })

  it('rejects an idempotency key reused with different content or another session', async () => {
    const context = await fixture()
    const request = activity(context)
    const recorded = await repository.recordActivity(request)
    const otherSession = await startSession(context.name)
    const before = await projectRows(context.id)
    await expect(
      repository.recordActivity({ ...request, summary: 'A different outcome.' })
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' })
    await expect(
      repository.recordActivity({ ...request, sessionId: otherSession.id })
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' })
    expect(await projectRows(context.id)).toEqual(before)
    const rows = await pool.query<{ id: string; session_id: string }>(
      'SELECT id::text, session_id::text FROM activities WHERE idempotency_key = $1',
      [request.idempotencyKey]
    )
    expect(rows.rows).toEqual([{ id: recorded.id, session_id: context.session.id }])
  })

  it('rejects stale compare-and-swap without side effects and atomically replaces the current relation', async () => {
    const context = await relationFixture()
    const request = replacement(context, 'current')
    const before = await projectRows(context.id)
    await expect(
      repository.recordActivity({
        ...request,
        relationPreconditions: [
          {
            subjectUri: context.relation.subject.canonicalUri,
            relationTypes: [context.relation.relationType],
            expectedRelationIds: [randomUUID()]
          }
        ]
      })
    ).rejects.toMatchObject({ reason: 'relation_precondition_failed' })
    expect(await projectRows(context.id)).toEqual(before)
    const oldBefore = await pool.query<{ valid_to: Date | null }>(
      'SELECT valid_to FROM relations WHERE id = $1::uuid',
      [context.relationId]
    )
    expect(oldBefore.rows[0]!.valid_to).toBeNull()

    const occurredAt = new Date().toISOString()
    const recorded = await repository.recordActivity({ ...request, occurredAt })
    const rows = await pool.query<{
      id: string
      valid_to: Date | null
      canonical_uri: string
      asserted_by_activity_id: string
    }>(
      `SELECT r.id::text, r.valid_to, target.canonical_uri, r.asserted_by_activity_id::text
       FROM relations r JOIN objects subject ON subject.id = r.source_object_id
       JOIN objects target ON target.id = r.target_object_id
       WHERE subject.canonical_uri = $1 ORDER BY target.canonical_uri`,
      [context.relation.subject.canonicalUri]
    )
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.find((row) => row.id === context.relationId)?.valid_to?.toISOString()).toBe(
      occurredAt
    )
    expect(rows.rows.filter((row) => row.valid_to === null)).toEqual([
      expect.objectContaining({
        canonical_uri: request.relationEffects[1]!.target.canonicalUri,
        asserted_by_activity_id: recorded.id
      })
    ])
  })

  it('allows exactly one of two concurrent sessions to replace the same observed relation', async () => {
    const context = await relationFixture()
    const otherSession = await startSession(context.name)
    const requests = [
      replacement(context, 'writer-a'),
      { ...replacement(context, 'writer-b'), sessionId: otherSession.id }
    ]
    const gate = await pool.connect()
    let pending:
      | ReturnType<typeof Promise.allSettled<Awaited<ReturnType<typeof repository.recordActivity>>>>
      | undefined
    try {
      await gate.query('BEGIN')
      const backend = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await gate.query("SELECT pg_advisory_xact_lock(hashtext('boron-ontology-write'))")
      pending = Promise.allSettled(requests.map((request) => repository.recordActivity(request)))
      await expectBlockedWriters(backend.rows[0]!.pid, 2)
    } finally {
      await gate.query('ROLLBACK')
      gate.release()
      // Settle both writers even if the lock-wait assertion fails.
      if (pending) await pending
    }
    const results = await pending!
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ reason: 'relation_precondition_failed' })
      })
    ])
    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled')
    const current = await pool.query<{ canonical_uri: string }>(
      `SELECT target.canonical_uri FROM current_relations r
       JOIN objects subject ON subject.id = r.source_object_id
       JOIN objects target ON target.id = r.target_object_id
       WHERE subject.canonical_uri = $1`,
      [context.relation.subject.canonicalUri]
    )
    expect(current.rows).toEqual([
      { canonical_uri: requests[winnerIndex]!.relationEffects[1]!.target.canonicalUri }
    ])
    const written = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM activities WHERE idempotency_key = ANY($1::text[])',
      [requests.map((request) => request.idempotencyKey)]
    )
    expect(written.rows[0]!.count).toBe(1)
  })

  it('serializes activity, registry, and supersession writers through the same ontology lock', async () => {
    const context = await fixture()
    const archived = await fixture()
    const registrySource = `integration://trusted-registry/${context.suffix}`
    const registry: CodexRegistry = {
      provenance: 'Disposable trusted continuity integration fixture',
      authority: 'user_approved',
      stateUri: `integration://trusted-registry-state/${context.suffix}`,
      manifestUri: `integration://trusted-registry-manifest/${context.suffix}`,
      projects: [],
      independentProjects: [
        {
          canonicalName: `Trusted registry ${context.suffix}`,
          sourceUri: registrySource,
          aliases: [],
          roots: [],
          ignoredRoots: []
        }
      ],
      supersedeAliases: [],
      supersedeObjects: [],
      standaloneIdentities: []
    }
    const request = activity(context)
    const gate = await pool.connect()
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await gate.query('BEGIN')
      const backend = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await gate.query("SELECT pg_advisory_xact_lock(hashtext('boron-ontology-write'))")
      pending = Promise.allSettled([
        repository.recordActivity(request),
        reconcileCodexRegistry(pool, registry, true),
        reconcileProjectSupersessions(
          pool,
          {
            manifestUri: `integration://trusted-supersession/${archived.suffix}`,
            manifest: {
              version: 1,
              authority: 'user_approved',
              provenance: 'Disposable trusted continuity integration fixture',
              repairs: [
                {
                  action: 'archive',
                  sourceUri: `integration://trusted-continuity/${archived.suffix}`,
                  reason: 'Exercise shared writer serialization on an isolated fixture.'
                }
              ]
            }
          },
          true
        )
      ])
      await expectBlockedWriters(backend.rows[0]!.pid, 3)
      const blocked = await pool.query<{ activities: number; projects: number; status: string }>(
        `SELECT
           (SELECT count(*)::int FROM activities WHERE idempotency_key = $1) AS activities,
           (SELECT count(*)::int FROM projects WHERE source_uri = $2) AS projects,
           (SELECT status FROM projects WHERE id = $3::uuid) AS status`,
        [request.idempotencyKey, registrySource, archived.id]
      )
      expect(blocked.rows).toEqual([{ activities: 0, projects: 0, status: 'confirmed' }])
    } finally {
      await gate.query('ROLLBACK')
      gate.release()
      if (pending) await pending
    }
    const results = await pending!
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    const stored = await pool.query<{ activities: number; projects: number; status: string }>(
      `SELECT
         (SELECT count(*)::int FROM activities WHERE idempotency_key = $1) AS activities,
         (SELECT count(*)::int FROM projects WHERE source_uri = $2) AS projects,
         (SELECT status FROM projects WHERE id = $3::uuid) AS status`,
      [request.idempotencyKey, registrySource, archived.id]
    )
    expect(stored.rows).toEqual([{ activities: 1, projects: 1, status: 'archived' }])
  })

  async function capsuleFixture(context: Fixture) {
    const capsuleId = randomUUID()
    const selectedId = `selected-${randomUUID()}`
    const unselectedId = `unselected-${randomUUID()}`
    const selectedUri = `integration://trusted-evidence/${selectedId}`
    const sample = await pool.query<{ id: string }>(
      `INSERT INTO context_meter_samples (
         capsule_id, trace_id, project_id, client, candidate_evidence_count, selected_evidence_count,
         candidate_tokens, capsule_tokens, filtered_tokens, recovered_context_tokens,
         source_estimate_covered_evidence, source_tokens, source_excerpt_tokens,
         source_compression_tokens, retrieval_latency_ms
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'trusted-continuity-integration-test',
         2, 1, 40, 20, 20, 0, 0, 0, 0, 0, 1) RETURNING id::text`,
      [capsuleId, randomUUID(), context.id]
    )
    await pool.query(
      `INSERT INTO context_meter_evidence_samples (
         meter_sample_id, evidence_id, layer, title, uri, adapter_name, adapter_source_type,
         stage_id, candidate_tokens, selected, score
       ) VALUES
         ($1::uuid, $2, 'wiki', 'Selected fixture', $3, 'fixture', 'snapshot', 'wiki', 20, true, 1),
         ($1::uuid, $4, 'wiki', 'Unselected fixture', $5, 'fixture', 'snapshot', 'wiki', 20, false, 0.5)`,
      [
        sample.rows[0]!.id,
        selectedId,
        selectedUri,
        unselectedId,
        `integration://trusted-evidence/${unselectedId}`
      ]
    )
    return { capsuleId, selectedId, selectedUri, unselectedId }
  }

  function resultEvidence(context: Fixture): ActivityEvidenceInput & { uri: string } {
    return {
      layer: 'wiki',
      title: 'Verified fixture output',
      uri: `integration://trusted-result/${context.suffix}`,
      excerpt: 'This fixture reports the verified result of applying selected context.',
      confidence: 1,
      authority: 1,
      metadata: { integrationTest: true }
    }
  }

  it('accepts a scoped use report backed by selected evidence and preserves its verification caveat', async () => {
    const context = await fixture()
    const capsule = await capsuleFixture(context)
    const input: RecordContextUseRequest = {
      sessionId: context.session.id,
      projectHint: context.name,
      capsuleId: capsule.capsuleId,
      evidenceIds: [capsule.selectedId],
      disposition: 'applied',
      summary: 'Applied the selected evidence to the verified fixture result.',
      idempotencyKey: `context-use-${context.suffix}`,
      evidence: [resultEvidence(context)]
    }
    const recorded = await repository.recordContextUse(input)
    const retried = await repository.recordContextUse(input)
    expect(retried).toMatchObject({ id: recorded.id, duplicate: true })
    const stored = await pool.query<{ project_id: string; context_use: Record<string, unknown> }>(
      `SELECT project_id::text, payload->'contextUse' AS context_use FROM activities WHERE id = $1::uuid`,
      [recorded.id]
    )
    expect(stored.rows[0]).toMatchObject({
      project_id: context.id,
      context_use: {
        capsuleId: capsule.capsuleId,
        evidenceIds: [capsule.selectedId],
        selectedEvidence: [{ evidence_id: capsule.selectedId, uri: capsule.selectedUri }],
        disposition: 'applied',
        basis: 'client_report_with_validated_selection'
      }
    })
    expect(stored.rows[0]!.context_use.caveat).toMatch(/not independent proof/)
    const evidence = await pool.query<{ uri: string }>(
      `SELECT uri FROM evidence WHERE metadata->>'activityId' = $1 AND uri = $2`,
      [recorded.id, input.evidence[0]!.uri]
    )
    expect(evidence.rows).toEqual([{ uri: input.evidence[0]!.uri }])
  })

  it('rejects unselected evidence, a foreign capsule or project, and use reports without result evidence', async () => {
    const context = await fixture()
    const capsule = await capsuleFixture(context)
    const foreign = await fixture()
    const foreignCapsule = await capsuleFixture(foreign)
    const input: RecordContextUseRequest = {
      sessionId: context.session.id,
      projectHint: context.name,
      capsuleId: capsule.capsuleId,
      evidenceIds: [capsule.selectedId],
      disposition: 'applied',
      summary: 'A context-use request requiring validation.',
      idempotencyKey: `rejected-use-${context.suffix}`,
      evidence: [resultEvidence(context)]
    }
    const before = await projectRows(context.id)
    for (const override of [
      { evidenceIds: [capsule.unselectedId] },
      { evidenceIds: [capsule.selectedId, capsule.selectedId] },
      { capsuleId: foreignCapsule.capsuleId, evidenceIds: [foreignCapsule.selectedId] },
      { evidence: [] }
    ]) {
      await expect(repository.recordContextUse({ ...input, ...override })).rejects.toMatchObject({
        reason: 'invalid_context_use'
      })
    }
    await expect(
      repository.recordContextUse({ ...input, projectHint: foreign.name })
    ).rejects.toMatchObject({ reason: 'project_mismatch' })
    expect(await projectRows(context.id)).toEqual(before)
  })

  it('reports measured source expansion as negative net savings while keeping legacy savings nonnegative', async () => {
    const context = await fixture()
    const adapter: ContextAdapter = {
      layer: 'wiki',
      name: 'trusted-continuity-source-size-fixture',
      sourceType: 'live',
      health: async () => ({ ok: true }),
      search: async () => [
        {
          id: `source-expansion-${context.suffix}`,
          layer: 'wiki',
          title: 'A small source with a larger provenance wrapper',
          uri: `integration://source-expansion/${context.suffix}`,
          excerpt: 'OK',
          confidence: 1,
          authority: 1,
          projectId: context.id,
          metadata: { sourceTokenEstimate: 1 }
        }
      ]
    }
    const resolver = new ContextResolver({
      projects: { resolve: async () => ({ id: context.id, name: context.name, confidence: 1 }) },
      adapters: [adapter]
    })
    const resolution = await resolver.resolveWithAudit({
      objective: 'Read the fixture source-size evidence',
      projectHint: context.name,
      layers: ['wiki'],
      tokenBudget: 4_000,
      client: 'trusted-continuity-integration-test'
    })
    expect(resolution.capsule.meter.sourceWindowCoveredEvidenceCount).toBe(1)
    expect(resolution.capsule.meter.sourceWindowSavingsTokens).toBe(0)
    expect(resolution.capsule.meter.sourceWindowNetSavingsTokens).toBeLessThan(0)
    await repository.saveMeter(resolution.capsule, resolution.evidenceAudit)
    const summary = await repository.contextMeterSummary({
      projectHint: context.name,
      windowDays: 7,
      typingWordsPerMinute: 40
    })
    expect(summary.sourceWindow).toMatchObject({
      coveredEvidenceCount: 1,
      originalTokens: 1,
      savingsTokens: 0,
      netSavingsTokens: resolution.capsule.meter.sourceWindowNetSavingsTokens
    })
    expect(summary.sourceWindow.netSavingsTokens).toBeLessThan(0)
  })

  it('rolls back completion evidence, relation changes, and lease updates when the status update fails', async () => {
    const context = await relationFixture()
    const replacementRequest = replacement(context, 'must-roll-back')
    const input: CompleteSessionRequest = {
      sessionId: context.session.id,
      // Bypass request parsing to fail the final database CHECK after all earlier writes.
      outcome: 'invalid-outcome' as CompleteSessionRequest['outcome'],
      summary: 'No part of this failed completion may remain committed.',
      decisions: ['A decision that must roll back.'],
      relationEffects: replacementRequest.relationEffects,
      evidence: [resultEvidence(context)],
      metadata: { integrationTest: true, failedCompletionMustNotPersist: true }
    }
    const before = await projectRows(context.id)
    const beforeSession = await pool.query(
      'SELECT status, ended_at, last_seen_at, lease_expires_at, metadata FROM agent_sessions WHERE id = $1::uuid',
      [context.session.id]
    )
    await expect(repository.completeSession(input)).rejects.toMatchObject({ code: '23514' })
    expect(await projectRows(context.id)).toEqual(before)
    const afterSession = await pool.query(
      'SELECT status, ended_at, last_seen_at, lease_expires_at, metadata FROM agent_sessions WHERE id = $1::uuid',
      [context.session.id]
    )
    expect(afterSession.rows).toEqual(beforeSession.rows)
    const oldRelation = await pool.query<{ valid_to: Date | null }>(
      'SELECT valid_to FROM relations WHERE id = $1::uuid',
      [context.relationId]
    )
    expect(oldRelation.rows[0]!.valid_to).toBeNull()
    await repository.completeSession({
      ...input,
      outcome: 'completed',
      relationEffects: [],
      metadata: {}
    })
    const completed = await pool.query<{ status: string }>(
      'SELECT status FROM agent_sessions WHERE id = $1::uuid',
      [context.session.id]
    )
    expect(completed.rows).toEqual([{ status: 'completed' }])
  })
})

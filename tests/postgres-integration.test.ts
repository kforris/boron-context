import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PostgresActivityRepository } from '../src/db/activity-repository.js'
import { ActivityTimestampError, ProjectScopeError } from '../src/core/errors.js'
import { PostgresCodexThreadRepository } from '../src/db/codex-thread-repository.js'
import { reconcileCodexRegistry, type CodexRegistry } from '../src/db/project-registry.js'
import { reconcileProjectSupersessions } from '../src/db/project-supersession.js'

const databaseUrl = process.env.BORON_TEST_DATABASE_URL
const describeDatabase = databaseUrl ? describe : describe.skip

describeDatabase('PostgreSQL continuity integration', () => {
  let pool: Pool
  let repository: PostgresActivityRepository
  let codexThreads: PostgresCodexThreadRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    repository = new PostgresActivityRepository(pool)
    codexThreads = new PostgresCodexThreadRepository(pool)
    await pool.query(
      `
        INSERT INTO projects (name, source_uri, status, metadata)
        VALUES ('Boron Context', 'github://kforris/boron-context', 'confirmed', '{}'::jsonb)
        ON CONFLICT (source_uri) DO UPDATE SET status = 'confirmed'
      `
    )
  })

  afterAll(async () => {
    await pool.end()
  })

  it('keeps uncertain relation endpoints candidate and promotes them on explicit confirmation', async () => {
    const suffix = randomUUID()
    const subjectUri = `integration://candidate-subject/${suffix}`
    const targetUri = `integration://candidate-target/${suffix}`
    const session = await repository.startSession({
      objective: 'Verify candidate and confirmed relation endpoint behavior',
      projectHint: 'Boron Context',
      projectRoot: process.cwd(),
      externalSessionId: `postgres-integration-${suffix}`,
      client: 'postgres-integration-test',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    const relation = {
      subject: { kind: 'TestSubject', name: 'Candidate subject', canonicalUri: subjectUri },
      relationType: 'VERIFIES',
      target: { kind: 'TestTarget', name: 'Candidate target', canonicalUri: targetUri },
      operation: 'assert' as const,
      confidence: 1,
      rationale: 'Database integration verification.'
    }

    await repository.recordActivity({
      sessionId: session.id,
      activityType: 'integration.candidate',
      summary: 'Record an uncertain relation.',
      confidence: 1,
      metadata: {},
      relationEffects: [{ ...relation, confirmationState: 'candidate' }],
      evidence: []
    })
    const candidate = await pool.query<{ confirmation_state: string }>(
      'SELECT confirmation_state FROM objects WHERE canonical_uri = ANY($1::text[]) ORDER BY canonical_uri',
      [[subjectUri, targetUri]]
    )
    expect(candidate.rows.map((row) => row.confirmation_state)).toEqual(['candidate', 'candidate'])

    await repository.recordActivity({
      sessionId: session.id,
      activityType: 'integration.confirmed',
      summary: 'Explicitly confirm the verified relation.',
      confidence: 1,
      metadata: {},
      relationEffects: [{ ...relation, confirmationState: 'confirmed' }],
      evidence: []
    })
    const confirmed = await pool.query<{ confirmation_state: string }>(
      'SELECT confirmation_state FROM objects WHERE canonical_uri = ANY($1::text[]) ORDER BY canonical_uri',
      [[subjectUri, targetUri]]
    )
    expect(confirmed.rows.map((row) => row.confirmation_state)).toEqual(['confirmed', 'confirmed'])
    const currentRelation = await pool.query<{ confirmation_state: string }>(
      `
        SELECT r.confirmation_state
        FROM relations r
        JOIN objects source ON source.id = r.source_object_id
        JOIN objects target ON target.id = r.target_object_id
        WHERE source.canonical_uri = $1 AND target.canonical_uri = $2 AND r.valid_to IS NULL
      `,
      [subjectUri, targetUri]
    )
    expect(currentRelation.rows).toEqual([{ confirmation_state: 'confirmed' }])

    await repository.completeSession({
      sessionId: session.id,
      outcome: 'completed',
      summary: 'PostgreSQL relation confirmation integration passed.',
      decisions: [],
      relationEffects: [],
      evidence: [],
      metadata: { integrationTest: true }
    })
  })

  it('rejects cross-project and future-skewed writeback while auditing explicit scope', async () => {
    const suffix = randomUUID()
    const otherName = `Independent integration ${suffix}`
    await pool.query(
      `
        INSERT INTO projects (name, source_uri, status, metadata)
        VALUES ($1, $2, 'confirmed', '{"integrationTest":true}'::jsonb)
      `,
      [otherName, `integration://project/${suffix}`]
    )
    const session = await repository.startSession({
      objective: 'Verify project-scoped writeback integrity',
      projectHint: 'Boron Context',
      externalSessionId: `writeback-integrity-${suffix}`,
      client: 'postgres-integration-test',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    const base = {
      sessionId: session.id,
      activityType: 'integration.writeback_scope',
      summary: 'Verify explicit project scope.',
      confidence: 1,
      metadata: { integrationTest: true },
      relationEffects: [],
      evidence: []
    }

    await expect(
      repository.recordActivity({ ...base, projectHint: otherName })
    ).rejects.toBeInstanceOf(ProjectScopeError)
    await expect(
      repository.recordActivity({
        ...base,
        projectHint: 'Boron Context',
        occurredAt: new Date(Date.now() + 6 * 60 * 1_000).toISOString()
      })
    ).rejects.toBeInstanceOf(ActivityTimestampError)
    await repository.recordActivity({ ...base, projectHint: 'Boron Context' })

    const quality = await repository.contextQualityHealth({
      projectHint: 'Boron Context',
      windowDays: 30
    })
    expect(quality.project).toBe('Boron Context')
    expect(quality.writebackScope.explicitProject).toBeGreaterThanOrEqual(1)
    expect(quality.boronLlmCalls).toBe(0)

    await repository.completeSession({
      sessionId: session.id,
      outcome: 'completed',
      summary: 'Project-scoped writeback integrity passed.',
      decisions: [],
      relationEffects: [],
      evidence: [],
      metadata: { integrationTest: true }
    })
  })

  it('applies an operator-approved independent project registry idempotently', async () => {
    const suffix = randomUUID()
    const canonicalName = `Independent registry ${suffix}`
    const sourceUri = `integration://independent-registry/${suffix}`
    const registry: CodexRegistry = {
      provenance: 'PostgreSQL integration test approval',
      authority: 'user_approved',
      stateUri: 'file:///tmp/integration-codex-state.json',
      manifestUri: 'file:///tmp/integration-project-manifest.json',
      projects: [],
      independentProjects: [
        {
          canonicalName,
          sourceUri,
          aliases: [canonicalName, `${canonicalName} alias`],
          roots: [process.cwd()],
          ignoredRoots: []
        }
      ],
      supersedeAliases: [],
      supersedeObjects: [],
      standaloneIdentities: []
    }

    const preview = await reconcileCodexRegistry(pool, registry, false)
    expect(preview.plan.independentProjects[0]).toMatchObject({
      sourceUri,
      matchReason: 'create'
    })
    const applied = await reconcileCodexRegistry(pool, registry, true)
    expect(applied.independentProjectsCreated).toBe(1)
    expect(applied.independentRootRelations).toBe(1)
    const repeated = await reconcileCodexRegistry(pool, registry, true)
    expect(repeated.independentProjectsCreated).toBe(0)
    expect(repeated.independentProjectsAdopted).toBe(1)
    expect(repeated.independentRootRelations).toBe(0)

    const project = await pool.query<{
      name: string
      status: string
      registry_kind: string
      aliases: string[]
    }>(
      `
        SELECT
          p.name,
          p.status,
          p.metadata->>'registryKind' AS registry_kind,
          array_agg(a.alias ORDER BY a.alias) AS aliases
        FROM projects p
        JOIN project_aliases a ON a.project_id = p.id
        WHERE p.source_uri = $1
        GROUP BY p.id
      `,
      [sourceUri]
    )
    expect(project.rows[0]).toMatchObject({
      name: canonicalName,
      status: 'confirmed',
      registry_kind: 'independent',
      aliases: [canonicalName, `${canonicalName} alias`].sort()
    })
  })

  it('keeps noncanonical aliases candidate after the migration 007 correction', async () => {
    const suffix = randomUUID()
    const object = await pool.query<{ id: string }>(
      `
        INSERT INTO objects (kind, name, canonical_uri, confirmation_state)
        VALUES ('IntegrationEntity', 'Canonical entity', $1, 'confirmed')
        RETURNING id::text
      `,
      [`integration://alias-boundary/${suffix}`]
    )
    await pool.query(
      `
        INSERT INTO object_aliases (
          object_id, alias, normalized_alias, confirmation_state, metadata
        )
        VALUES
          ($1::uuid, 'Canonical entity', 'canonical entity', 'confirmed', $2::jsonb),
          ($1::uuid, 'Uncertain nickname', 'uncertain nickname', 'confirmed', $2::jsonb)
      `,
      [object.rows[0]!.id, JSON.stringify({ confirmationMigration: '007_agent_continuity_health' })]
    )

    const correction = await readFile(
      resolve(process.cwd(), 'migrations/008_object_alias_confirmation_boundary.sql'),
      'utf8'
    )
    await pool.query(correction)

    const aliases = await pool.query<{
      alias: string
      confirmation_state: string
      correction: string | null
    }>(
      `
        SELECT
          alias,
          confirmation_state,
          metadata->>'confirmationCorrection' AS correction
        FROM object_aliases
        WHERE object_id = $1::uuid
        ORDER BY alias
      `,
      [object.rows[0]!.id]
    )
    expect(aliases.rows).toEqual([
      { alias: 'Canonical entity', confirmation_state: 'confirmed', correction: null },
      {
        alias: 'Uncertain nickname',
        confirmation_state: 'candidate',
        correction: 'noncanonical_alias_requires_review'
      }
    ])
  })

  it('bootstraps only scoped projects and closes client lifecycle sessions idempotently', async () => {
    const suffix = randomUUID()
    const externalSessionId = `postgres-lifecycle-${suffix}`
    const skipped = await repository.bootstrapSession({
      objective: 'Load automatic context without creating a broad-root project.',
      projectHint: 'Unregistered broad root',
      projectRoot: homedir(),
      externalSessionId: `broad-root-${suffix}`,
      client: 'codex',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    expect(skipped).toBeNull()

    const unknownRoot = `/tmp/boron-unregistered-${suffix}`
    const unknown = await repository.bootstrapSession({
      objective: 'Do not create an authoritative project from an unknown temporary root.',
      projectRoot: unknownRoot,
      externalSessionId: `unknown-root-${suffix}`,
      client: 'codex',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    expect(unknown).toBeNull()
    const unknownProject = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM projects WHERE source_uri = $1`,
      [`file://${unknownRoot}`]
    )
    expect(unknownProject.rows[0]?.count).toBe(0)

    const session = await repository.bootstrapSession({
      objective: 'Load automatic project continuity.',
      projectHint: 'Boron Context',
      projectRoot: process.cwd(),
      externalSessionId,
      client: 'codex',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    expect(session?.project?.name).toBe('Boron Context')

    const first = await repository.endSessionFromClientLifecycle({
      externalSessionId,
      client: 'codex',
      metadata: { integrationTest: true }
    })
    expect(first).toMatchObject({
      closed: true,
      sessionId: session!.id,
      status: 'partial',
      reason: 'client_session_end'
    })
    const second = await repository.endSessionFromClientLifecycle({
      externalSessionId,
      client: 'codex',
      metadata: { integrationTest: true }
    })
    expect(second).toEqual({
      closed: false,
      sessionId: null,
      status: null,
      reason: 'no_active_session'
    })
    const stored = await pool.query<{ status: string; closure_reason: string }>(
      'SELECT status, closure_reason FROM agent_sessions WHERE id = $1::uuid',
      [session!.id]
    )
    expect(stored.rows).toEqual([{ status: 'partial', closure_reason: 'client_session_end' }])
  })

  it('imports reviewed Codex thread ownership without ontology graph expansion', async () => {
    const suffix = randomUUID()
    const codexProjectId = `codex-project-${suffix}`
    const project = await pool.query<{ id: string }>(
      `
        INSERT INTO projects (name, source_uri, status, metadata)
        VALUES ($1, $2, 'confirmed', $3::jsonb)
        RETURNING id::text
      `,
      [
        `Thread sync project ${suffix}`,
        `codex-project://${codexProjectId}`,
        JSON.stringify({ codexProjectId })
      ]
    )
    const threadId = `thread-sync-${suffix}`
    const snapshotId = createHash('sha256').update(`snapshot-${suffix}`).digest('hex')
    const result = await codexThreads.sync({
      snapshotId,
      client: 'codex',
      source: 'integration_test',
      observedAt: new Date().toISOString(),
      observations: [
        {
          externalThreadId: threadId,
          codexProjectId,
          classificationState: 'confirmed',
          authority: 'user_approved_plan',
          confidence: 1,
          evidenceDigest: createHash('sha256').update(`thread-${suffix}`).digest('hex'),
          metadata: { contentRead: false }
        },
        {
          externalThreadId: `projectless-${suffix}`,
          classificationState: 'projectless',
          authority: 'user_approved_plan',
          confidence: 1,
          evidenceDigest: createHash('sha256').update(`projectless-${suffix}`).digest('hex'),
          metadata: { contentRead: false }
        }
      ],
      metadata: { privacyBoundary: 'no_prompt_or_transcript' }
    })
    expect(result).toMatchObject({
      duplicate: false,
      received: 2,
      confirmed: 1,
      projectless: 1,
      unresolvedProjects: 0
    })
    expect(
      await codexThreads.sync({
        snapshotId,
        client: 'codex',
        source: 'integration_test',
        observedAt: new Date().toISOString(),
        observations: [],
        metadata: {}
      })
    ).toMatchObject({ duplicate: true })

    const stored = await pool.query<{
      project_id: string | null
      classification_state: string
    }>(
      `
        SELECT project_id::text, classification_state
        FROM codex_thread_project_state
        WHERE client = 'codex' AND external_thread_id = $1
      `,
      [threadId]
    )
    expect(stored.rows).toEqual([
      { project_id: project.rows[0]!.id, classification_state: 'confirmed' }
    ])
    const session = await repository.bootstrapSession({
      objective: 'Resolve this task from reviewed thread ownership.',
      projectRoot: homedir(),
      externalSessionId: threadId,
      client: 'codex',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    expect(session?.project?.id).toBe(project.rows[0]!.id)
    const ontologyObjects = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM objects WHERE canonical_uri = $1`,
      [`codex-thread://${threadId}`]
    )
    expect(ontologyObjects.rows[0]?.count).toBe(0)
  })

  it('keeps uncertain ownership candidate and fails closed on equal-authority conflicts', async () => {
    const suffix = randomUUID()
    const firstCodexProjectId = `candidate-project-${suffix}`
    const secondCodexProjectId = `conflicting-project-${suffix}`
    await pool.query(
      `
        INSERT INTO projects (name, source_uri, status, metadata)
        VALUES
          ($1, $2, 'confirmed', $3::jsonb),
          ($4, $5, 'confirmed', $6::jsonb)
      `,
      [
        `Candidate project ${suffix}`,
        `codex-project://${firstCodexProjectId}`,
        JSON.stringify({ codexProjectId: firstCodexProjectId }),
        `Conflicting project ${suffix}`,
        `codex-project://${secondCodexProjectId}`,
        JSON.stringify({ codexProjectId: secondCodexProjectId })
      ]
    )
    const candidateThreadId = `candidate-thread-${suffix}`
    const conflictThreadId = `conflict-thread-${suffix}`
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')

    const candidate = await codexThreads.sync({
      snapshotId: digest(`candidate-snapshot-${suffix}`),
      client: 'codex',
      source: 'integration_test',
      observedAt: new Date().toISOString(),
      observations: [
        {
          externalThreadId: candidateThreadId,
          codexProjectId: firstCodexProjectId,
          classificationState: 'candidate',
          authority: 'candidate',
          confidence: 0.6,
          evidenceDigest: digest(`candidate-evidence-${suffix}`),
          metadata: { contentRead: false }
        },
        {
          externalThreadId: conflictThreadId,
          codexProjectId: firstCodexProjectId,
          classificationState: 'confirmed',
          authority: 'codex_project_assignment',
          confidence: 1,
          evidenceDigest: digest(`first-conflict-evidence-${suffix}`),
          metadata: { contentRead: false }
        }
      ],
      metadata: {}
    })
    expect(candidate).toMatchObject({ candidate: 1, confirmed: 1 })

    await codexThreads.sync({
      snapshotId: digest(`conflict-snapshot-${suffix}`),
      client: 'codex',
      source: 'integration_test',
      observedAt: new Date().toISOString(),
      observations: [
        {
          externalThreadId: conflictThreadId,
          codexProjectId: secondCodexProjectId,
          classificationState: 'confirmed',
          authority: 'codex_project_assignment',
          confidence: 1,
          evidenceDigest: digest(`second-conflict-evidence-${suffix}`),
          metadata: { contentRead: false }
        }
      ],
      metadata: {}
    })

    const state = await pool.query<{
      external_thread_id: string
      project_id: string | null
      classification_state: string
    }>(
      `
        SELECT external_thread_id, project_id::text, classification_state
        FROM codex_thread_project_state
        WHERE external_thread_id = ANY($1::text[])
        ORDER BY external_thread_id
      `,
      [[candidateThreadId, conflictThreadId]]
    )
    expect(state.rows).toEqual([
      {
        external_thread_id: candidateThreadId,
        project_id: expect.any(String),
        classification_state: 'candidate'
      },
      {
        external_thread_id: conflictThreadId,
        project_id: null,
        classification_state: 'conflicted'
      }
    ])
  })

  it('moves non-conflicting retrieval policies during an auditable project supersession', async () => {
    const suffix = randomUUID()
    const sourceUri = `integration://supersession-source/${suffix}`
    const targetUri = `integration://supersession-target/${suffix}`
    const canonicalUri = `integration://supersession-canonical/${suffix}`
    const source = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, source_uri, status) VALUES ($1, $2, 'confirmed') RETURNING id::text`,
      ['Superseded project', sourceUri]
    )
    const target = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, source_uri, status) VALUES ($1, $2, 'confirmed') RETURNING id::text`,
      ['Canonical project', targetUri]
    )
    await pool.query(
      `
        INSERT INTO retrieval_policies (
          project_id, name, policy_type, risk_class, instruction, source_uri,
          priority, confirmation_state, status
        )
        VALUES ($1::uuid, 'Release safety', 'authorization', 'high',
          'Require explicit publication authority.', $2, 100, 'confirmed', 'active')
      `,
      [source.rows[0]!.id, `policy://release-safety/${suffix}`]
    )
    const manifest = {
      version: 1 as const,
      authority: 'user_approved' as const,
      provenance: 'PostgreSQL integration verification.',
      repairs: [
        {
          action: 'merge' as const,
          sourceUri,
          targetMatchSourceUri: targetUri,
          targetCanonicalSourceUri: canonicalUri,
          canonicalName: 'Canonical project',
          aliases: ['Canonical alias'],
          sessionIds: [],
          reason: 'Deterministic integration-test supersession.'
        }
      ]
    }

    const result = await reconcileProjectSupersessions(
      pool,
      { manifest, manifestUri: `file:///integration/${suffix}.json` },
      true
    )
    expect(result).toMatchObject({ applied: true, mergedProjects: 1 })
    const policy = await pool.query<{ project_id: string }>(
      `SELECT project_id::text FROM retrieval_policies WHERE name = 'Release safety' AND source_uri = $1`,
      [`policy://release-safety/${suffix}`]
    )
    expect(policy.rows).toEqual([{ project_id: target.rows[0]!.id }])
    const projects = await pool.query<{ source_uri: string; status: string }>(
      'SELECT source_uri, status FROM projects WHERE id = ANY($1::uuid[]) ORDER BY source_uri',
      [[source.rows[0]!.id, target.rows[0]!.id]]
    )
    expect(projects.rows).toEqual([
      { source_uri: canonicalUri, status: 'confirmed' },
      { source_uri: sourceUri, status: 'archived' }
    ])

    const previewAgain = await reconcileProjectSupersessions(
      pool,
      { manifest, manifestUri: `file:///integration/${suffix}.json` },
      false
    )
    expect(previewAgain.plan).toHaveLength(1)
  })
})

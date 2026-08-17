import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PostgresActivityRepository } from '../src/db/activity-repository.js'
import {
  ActivityTimestampError,
  OntologyGovernanceError,
  ProjectScopeError
} from '../src/core/errors.js'
import { PostgresCodexThreadRepository } from '../src/db/codex-thread-repository.js'
import { PostgresInspectorRepository } from '../src/db/inspector-repository.js'
import { reconcileCodexRegistry, type CodexRegistry } from '../src/db/project-registry.js'
import { reconcileProjectSupersessions } from '../src/db/project-supersession.js'
import { ContextResolver } from '../src/core/resolver.js'
import type { ContextAdapter } from '../src/core/context-adapter.js'
import type { Evidence } from '../src/core/contracts.js'

const databaseUrl = process.env.BORON_TEST_DATABASE_URL
const describeDatabase = databaseUrl ? describe : describe.skip

describeDatabase('PostgreSQL continuity integration', () => {
  let pool: Pool
  let repository: PostgresActivityRepository
  let codexThreads: PostgresCodexThreadRepository
  let inspector: PostgresInspectorRepository

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    repository = new PostgresActivityRepository(pool)
    codexThreads = new PostgresCodexThreadRepository(pool)
    inspector = new PostgresInspectorRepository(pool, '/tmp')
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
      subject: { kind: 'Project', name: 'Candidate subject', canonicalUri: subjectUri },
      relationType: 'VERIFIES',
      target: { kind: 'Artifact', name: 'Candidate target', canonicalUri: targetUri },
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
      relationEffects: [
        { ...relation, confirmationState: 'candidate', authority: 'agent_inference' }
      ],
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
      relationEffects: [
        { ...relation, confirmationState: 'confirmed', authority: 'deterministic_source' }
      ],
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

  it('rejects unknown ontology types, audits deprecated types, and enforces relation authority', async () => {
    const suffix = randomUUID()
    const session = await repository.startSession({
      objective: 'Verify ontology governance contract v1',
      projectHint: 'Boron Context',
      externalSessionId: `ontology-governance-${suffix}`,
      client: 'postgres-integration-test',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    await pool.query(
      `
        INSERT INTO ontology_type_registry (
          type_family, type_name, status, replacement_type, owner, source_authority, source_uri
        )
        VALUES
          ('entity_kind', $1, 'deprecated', 'Artifact', 'integration-test', 'operator', $2),
          ('relation_type', $3, 'deprecated', 'RELATED_TO', 'integration-test', 'operator', $4)
        ON CONFLICT (type_family, type_name) DO UPDATE SET
          status = EXCLUDED.status,
          replacement_type = EXCLUDED.replacement_type,
          owner = EXCLUDED.owner,
          source_authority = EXCLUDED.source_authority,
          source_uri = EXCLUDED.source_uri,
          updated_at = now()
      `,
      [
        `DeprecatedArtifact-${suffix}`,
        `integration://registry/entity/${suffix}`,
        `DEPRECATED_RELATION_${suffix}`,
        `integration://registry/relation/${suffix}`
      ]
    )
    const base = {
      sessionId: session.id,
      projectHint: 'Boron Context',
      activityType: 'integration.ontology_governance',
      summary: 'Exercise ontology governance decisions.',
      confidence: 1,
      metadata: { integrationTest: true },
      evidence: []
    }
    const unknownUri = `integration://unknown/${suffix}`
    await expect(
      repository.recordActivity({
        ...base,
        relationEffects: [
          {
            subject: { kind: `UnknownKind-${suffix}`, name: 'Unknown', canonicalUri: unknownUri },
            relationType: 'VERIFIES',
            target: {
              kind: 'Artifact',
              name: 'Known target',
              canonicalUri: `integration://known-target/${suffix}`
            },
            operation: 'assert',
            confidence: 0.7,
            confirmationState: 'candidate',
            authority: 'agent_inference',
            rationale: 'Unknown kinds must fail closed.'
          }
        ]
      })
    ).rejects.toBeInstanceOf(OntologyGovernanceError)
    const unknownObject = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM objects WHERE canonical_uri = $1',
      [unknownUri]
    )
    expect(Number(unknownObject.rows[0]!.count)).toBe(0)

    await expect(
      repository.recordActivity({
        ...base,
        relationEffects: [
          {
            subject: {
              kind: 'Project',
              name: 'Known source',
              canonicalUri: `integration://unknown-relation-source/${suffix}`
            },
            relationType: `UNKNOWN_RELATION_${suffix}`,
            target: {
              kind: 'Artifact',
              name: 'Known target',
              canonicalUri: `integration://unknown-relation-target/${suffix}`
            },
            operation: 'assert',
            confidence: 0.7,
            confirmationState: 'candidate',
            authority: 'agent_inference',
            rationale: 'Unknown relation types must fail closed.'
          }
        ]
      })
    ).rejects.toMatchObject({ reason: 'unknown_relation_type' })

    await expect(
      repository.recordActivity({
        ...base,
        relationEffects: [
          {
            subject: {
              kind: 'Project',
              name: 'Authority subject',
              canonicalUri: `integration://authority-subject/${suffix}`
            },
            relationType: 'VERIFIES',
            target: {
              kind: 'Artifact',
              name: 'Authority target',
              canonicalUri: `integration://authority-target/${suffix}`
            },
            operation: 'assert',
            confidence: 1,
            confirmationState: 'confirmed',
            authority: 'agent_inference',
            rationale: 'Inference alone cannot confirm a relation.'
          }
        ]
      })
    ).rejects.toMatchObject({ reason: 'confirmed_requires_authority' })

    const deprecated = await repository.recordActivity({
      ...base,
      relationEffects: [
        {
          subject: {
            kind: `DeprecatedArtifact-${suffix}`,
            name: 'Deprecated subject',
            canonicalUri: `integration://deprecated-subject/${suffix}`
          },
          relationType: `DEPRECATED_RELATION_${suffix}`,
          target: {
            kind: 'Artifact',
            name: 'Current target',
            canonicalUri: `integration://deprecated-target/${suffix}`
          },
          operation: 'assert',
          confidence: 0.8,
          confirmationState: 'candidate',
          authority: 'agent_inference',
          rationale: 'Deprecated vocabulary remains compatible but auditable.'
        }
      ]
    })
    expect(deprecated.ontologyGovernance).toMatchObject({
      contractVersion: 1,
      deprecated: 2
    })
    await pool.query(
      `
        INSERT INTO objects (
          project_id, kind, name, canonical_uri, confirmation_state, ontology_contract_version
        )
        SELECT id, 'Artifact', 'Labelled legacy fixture', $1, 'confirmed', 0
        FROM projects WHERE name = 'Boron Context'
      `,
      [`integration://legacy-contract/${suffix}`]
    )
    const health = await repository.ontologyGovernanceHealth({
      projectHint: 'Boron Context',
      windowDays: 30
    })
    expect(health.contractVersion).toBe(1)
    expect(health.decisions.rejected).toBeGreaterThanOrEqual(2)
    expect(health.decisions.deprecated).toBeGreaterThanOrEqual(2)
    expect(health.decisions.reasons.rejected).toMatchObject({
      unknown_entity_kind: expect.any(Number),
      unknown_relation_type: expect.any(Number),
      confirmed_requires_authority: expect.any(Number)
    })
    expect(health.registry.entityKinds.deprecated).toBeGreaterThanOrEqual(1)
    expect(health.registry.relationTypes.deprecated).toBeGreaterThanOrEqual(1)
    expect(health.stored.objects.contractV1).toBeGreaterThanOrEqual(2)
    expect(health.stored.objects.legacyContract).toBeGreaterThanOrEqual(1)

    await expect(
      repository.recordActivity({
        ...base,
        relationEffects: [
          {
            subject: {
              kind: 'Project',
              name: 'Missing relation source',
              canonicalUri: `integration://missing-relation-source/${suffix}`
            },
            relationType: 'RELATED_TO',
            target: {
              kind: 'Artifact',
              name: 'Missing relation target',
              canonicalUri: `integration://missing-relation-target/${suffix}`
            },
            operation: 'retract',
            confidence: 1,
            confirmationState: 'confirmed',
            authority: 'operator',
            rationale: 'Retraction must reference an active relation.'
          }
        ]
      })
    ).rejects.toMatchObject({ reason: 'relation_not_active' })

    const correction = await inspector.createCorrection({
      projectHint: 'Boron Context',
      layer: 'ontology',
      subjectKind: 'entity',
      subjectUri: unknownUri,
      fields: { kind: 'Artifact' },
      note: 'Operator review fixture for an unknown kind.'
    })
    expect(correction.status).toBe('pending')
    const resolved = await inspector.resolveCorrection({
      correctionId: correction.id,
      outcome: 'resolved',
      summary: 'Fixture verified the governance rejection and proposed registered replacement.',
      resolvedBy: 'postgres-integration-test'
    })
    expect(resolved).toMatchObject({ status: 'resolved' })
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

  it('instruments new local-file evidence while preserving directory and remote boundaries', async () => {
    const suffix = randomUUID()
    const root = await mkdtemp(join(tmpdir(), 'boron-postgres-source-size-'))
    const sourcePath = join(root, 'verified.md')
    await writeFile(sourcePath, '12345678')
    const fileUri = pathToFileURL(sourcePath).href
    const directoryUri = pathToFileURL(root).href
    const remoteUri = `https://example.test/${suffix}`
    const session = await repository.startSession({
      objective: 'Verify source-size ingestion boundaries',
      projectHint: 'Boron Context',
      projectRoot: process.cwd(),
      externalSessionId: `source-size-${suffix}`,
      client: 'postgres-integration-test',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    const owner = await pool.query<{ id: string }>(
      `
        INSERT INTO objects (
          project_id, kind, name, canonical_uri, confirmation_state,
          ontology_contract_version, metadata
        )
        VALUES ($1::uuid, 'project', 'Source-size project', $2, 'confirmed', 1, '{}'::jsonb)
        RETURNING id::text
      `,
      [session.project!.id, `integration://source-size-project/${suffix}`]
    )
    const registeredRoot = await pool.query<{ id: string }>(
      `
        INSERT INTO objects (
          project_id, kind, name, canonical_uri, confirmation_state,
          ontology_contract_version, metadata
        )
        VALUES ($1::uuid, 'local_root', 'Source-size root', $2, 'confirmed', 1, $3::jsonb)
        RETURNING id::text
      `,
      [
        session.project!.id,
        `integration://source-size-root/${suffix}`,
        JSON.stringify({ path: root })
      ]
    )
    await pool.query(
      `
        INSERT INTO relations (
          source_object_id, relation_type, target_object_id, confidence,
          confirmation_state, provenance, ontology_contract_version
        )
        VALUES ($1::uuid, 'HAS_REGISTERED_ROOT', $2::uuid, 1, 'confirmed',
          '{"source":"integration_test"}'::jsonb, 1)
      `,
      [owner.rows[0]!.id, registeredRoot.rows[0]!.id]
    )

    await repository.recordActivity({
      sessionId: session.id,
      projectHint: 'Boron Context',
      activityType: 'integration.source_size',
      summary: 'Record bounded source-size fixtures.',
      confidence: 1,
      metadata: { integrationTest: true },
      relationEffects: [],
      evidence: [
        {
          layer: 'codebase',
          title: 'Measured file',
          uri: fileUri,
          excerpt: 'Measured from file metadata.',
          confidence: 1,
          authority: 1,
          metadata: {}
        },
        {
          layer: 'codebase',
          title: 'Directory reference',
          uri: directoryUri,
          excerpt: 'Directory references have no source window.',
          confidence: 1,
          authority: 1,
          metadata: {}
        },
        {
          layer: 'wiki',
          title: 'Remote reference',
          uri: remoteUri,
          excerpt: 'Remote content is not fetched during writeback.',
          confidence: 1,
          authority: 1,
          metadata: {}
        }
      ]
    })

    const stored = await pool.query<{
      uri: string
      source_token_estimate: string | null
      source_size_status: string | null
      source_size_reason: string | null
      source_size_basis: string | null
    }>(
      `
        SELECT uri,
          metadata->>'sourceTokenEstimate' AS source_token_estimate,
          metadata->'sourceSize'->>'status' AS source_size_status,
          metadata->'sourceSize'->>'reason' AS source_size_reason,
          metadata->'sourceSize'->>'basis' AS source_size_basis
        FROM evidence
        WHERE uri = ANY($1::text[])
        ORDER BY uri
      `,
      [[fileUri, directoryUri, remoteUri]]
    )
    expect(stored.rows).toEqual([
      {
        uri: directoryUri,
        source_token_estimate: null,
        source_size_status: 'not_applicable',
        source_size_reason: 'local_directory_reference',
        source_size_basis: null
      },
      {
        uri: fileUri,
        source_token_estimate: '2',
        source_size_status: 'measured',
        source_size_reason: null,
        source_size_basis: 'local_file_bytes_divided_by_4'
      },
      {
        uri: remoteUri,
        source_token_estimate: null,
        source_size_status: 'unavailable',
        source_size_reason: 'remote_source_not_fetched',
        source_size_basis: null
      }
    ])
  })

  it('reports source coverage against an eligible denominator without rewriting legacy evidence', async () => {
    const suffix = randomUUID()
    const projectName = `Source coverage ${suffix}`
    const projectUri = `integration://source-coverage/${suffix}`
    const projectResult = await pool.query<{ id: string }>(
      `
        INSERT INTO projects (name, source_uri, status, metadata)
        VALUES ($1, $2, 'confirmed', '{"integrationTest":true}'::jsonb)
        RETURNING id::text
      `,
      [projectName, projectUri]
    )
    const project = { id: projectResult.rows[0]!.id, name: projectName, confidence: 1 }
    const resolve = async (adapters: readonly ContextAdapter[]) =>
      new ContextResolver({
        projects: { resolve: async () => project },
        adapters
      }).resolveWithAudit({
        objective: 'Inspect source coverage fixtures',
        projectHint: projectName,
        layers: [adapters[0]!.layer],
        tokenBudget: 4_000,
        client: 'postgres-integration-test'
      })

    const ontology = await resolve([
      fixtureAdapter('ontology', 'ontology', [
        coverageEvidence(project.id, 'ontology-measured', { sourceTokenEstimate: 400 }),
        coverageEvidence(project.id, 'ontology-derived', { ontologyKind: 'relation' }),
        coverageEvidence(
          project.id,
          'legacy-activity',
          { activityId: 'legacy' },
          'boron://activity/legacy'
        )
      ])
    ])
    const live = await resolve([
      fixtureAdapter('codebase', 'live', [
        coverageEvidence(project.id, 'live-measured', { sourceTokenEstimate: 500 }),
        coverageEvidence(project.id, 'live-missing')
      ])
    ])
    const snapshot = await resolve([
      fixtureAdapter('wiki', 'snapshot', [
        coverageEvidence(project.id, 'snapshot-measured', { sourceTokenEstimate: 300 }),
        coverageEvidence(project.id, 'snapshot-legacy')
      ])
    ])
    for (const resolution of [ontology, live, snapshot]) {
      await repository.saveMeter(resolution.capsule, resolution.evidenceAudit)
    }

    const summary = await repository.contextMeterSummary({
      projectHint: projectName,
      windowDays: 7,
      typingWordsPerMinute: 40
    })
    expect(summary.sourceWindow.eligibility).toMatchObject({
      contractVersion: 2,
      numerator: 3,
      eligibleDenominator: 4,
      ratio: 0.75,
      ineligible: 1,
      unobservable: 2
    })
    expect(summary.sourceWindow.eligibility.reasons).toMatchObject({
      eligible: {
        recorded_source_measured: 1,
        live_source_measured: 1,
        live_source_size_unavailable: 1,
        snapshot_source_measured: 1
      },
      ineligible: { ontology_derived: 1 },
      unobservable: { legacy_unknown_size: 1, legacy_snapshot_unknown_size: 1 }
    })
    expect(summary.sourceWindow.selectedEvidenceCount).toBe(7)

    const quality = await repository.contextQualityHealth({
      projectHint: projectName,
      windowDays: 7
    })
    expect(quality.sourceCoverage.eligibility).toEqual(summary.sourceWindow.eligibility)
  })

  it('separates eligible, ineligible, legacy, read-only, hook/MCP, and unobservable telemetry', async () => {
    const suffix = randomUUID()
    const before = await repository.adoptionHealth({ windowDays: 7 })

    const semantic = await repository.startSession({
      objective: 'Perform explicit semantic context work.',
      projectHint: 'Boron Context',
      externalSessionId: `telemetry-semantic-${suffix}`,
      client: 'codex',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })
    await repository.recordActivity({
      sessionId: semantic.id,
      projectHint: 'Boron Context',
      activityType: 'integration.telemetry_semantic',
      summary: 'Record one explicitly scoped semantic milestone.',
      confidence: 1,
      metadata: { integrationTest: true },
      relationEffects: [],
      evidence: []
    })
    await repository.observeAgentClient({
      clientInstanceId: `telemetry-semantic-${suffix}`,
      client: 'codex',
      integration: 'mcp',
      event: 'session_started',
      sessionId: semantic.id,
      metadata: { integrationTest: true }
    })

    const lifecycle = await repository.startSession({
      objective: 'Load lifecycle context only.',
      projectHint: 'Boron Context',
      externalSessionId: `telemetry-lifecycle-${suffix}`,
      client: 'codex',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true, automaticLifecycleHook: true }
    })
    await repository.observeAgentClient({
      clientInstanceId: `telemetry-lifecycle-${suffix}`,
      client: 'codex',
      integration: 'codex_hook',
      event: 'session_started',
      sessionId: lifecycle.id,
      metadata: { integrationTest: true }
    })
    await repository.observeAgentClient({
      clientInstanceId: `telemetry-read-${suffix}`,
      client: 'codex',
      integration: 'mcp',
      event: 'context_read',
      metadata: { integrationTest: true }
    })
    await repository.observeAgentClient({
      clientInstanceId: `telemetry-mcp-init-${suffix}`,
      client: 'codex',
      integration: 'mcp',
      event: 'initialized',
      metadata: { integrationTest: true }
    })
    await repository.observeAgentClient({
      clientInstanceId: `telemetry-hook-miss-${suffix}`,
      client: 'codex',
      integration: 'codex_hook',
      event: 'initialized',
      metadata: { integrationTest: true }
    })
    await pool.query(
      `
        INSERT INTO agent_client_observations (
          client_instance_id, client, context_mode, telemetry_contract_version, metadata
        )
        VALUES ($1, 'codex', 'none', 1, '{"integrationTest":true}'::jsonb)
      `,
      [`telemetry-legacy-${suffix}`]
    )
    await pool.query(
      `
        INSERT INTO activities (
          session_id, project_id, activity_type, summary, source, confidence, payload,
          occurred_at, telemetry_contract_version
        )
        SELECT id, project_id, 'integration.legacy_implicit',
          'Preserve a legacy implicit record as labelled history.', 'integration-test', 1,
          '{"writebackScope":{"verification":"implicit_session"}}'::jsonb, now(), 1
        FROM agent_sessions WHERE id = $1::uuid
      `,
      [lifecycle.id]
    )
    await codexThreads.sync({
      snapshotId: createHash('sha256').update(`telemetry-unobservable-${suffix}`).digest('hex'),
      client: 'codex',
      source: 'integration_test',
      observedAt: new Date().toISOString(),
      observations: [
        {
          externalThreadId: `telemetry-unobservable-${suffix}`,
          classificationState: 'projectless',
          authority: 'user_approved_plan',
          confidence: 1,
          evidenceDigest: createHash('sha256').update(`unobservable-${suffix}`).digest('hex'),
          metadata: { contentRead: false }
        }
      ],
      metadata: { integrationTest: true }
    })

    const after = await repository.adoptionHealth({ windowDays: 7 })
    expect(after.contractVersion).toBe(2)
    expect(after.adoption.numerator - before.adoption.numerator).toBe(2)
    expect(after.adoption.eligibleDenominator - before.adoption.eligibleDenominator).toBe(3)
    expect(after.adoption.ineligible - before.adoption.ineligible).toBe(3)
    expect(after.adoption.unobservable - before.adoption.unobservable).toBe(1)
    expect(after.adoption.reasons.eligible).toMatchObject({
      semantic_context_work: expect.any(Number),
      read_only_context: expect.any(Number),
      hook_task_without_context: expect.any(Number)
    })
    expect(after.adoption.reasons.ineligible).toMatchObject({
      lifecycle_only: expect.any(Number),
      mcp_initialization_only: expect.any(Number),
      legacy_unclassified_observation: expect.any(Number)
    })
    expect(after.adoption.reasons.unobservable).toMatchObject({
      plugin_not_observed: expect.any(Number)
    })
    expect(after.writeback.numerator - before.writeback.numerator).toBe(1)
    expect(after.writeback.eligibleDenominator - before.writeback.eligibleDenominator).toBe(1)
    expect(after.writeback.reasons.ineligible).toMatchObject({
      lifecycle_or_intent: expect.any(Number),
      legacy_implicit_record: expect.any(Number)
    })
  })

  it('rejects resuming one external session under a different project identity', async () => {
    const suffix = randomUUID()
    const externalSessionId = `resume-scope-${suffix}`
    const otherName = `Resume target ${suffix}`
    await pool.query(
      `
        INSERT INTO projects (name, source_uri, status, metadata)
        VALUES ($1, $2, 'confirmed', '{"integrationTest":true}'::jsonb)
      `,
      [otherName, `integration://resume-target/${suffix}`]
    )
    const session = await repository.startSession({
      objective: 'Open the original scoped session.',
      projectHint: 'Boron Context',
      externalSessionId,
      client: 'postgres-integration-test',
      constraints: [],
      tokenBudget: 512,
      leaseMinutes: 15,
      metadata: { integrationTest: true }
    })

    await expect(
      repository.startSession({
        objective: 'Do not silently retarget an active session.',
        projectHint: otherName,
        externalSessionId,
        client: 'postgres-integration-test',
        constraints: [],
        tokenBudget: 512,
        leaseMinutes: 15,
        metadata: { integrationTest: true }
      })
    ).rejects.toMatchObject({ reason: 'project_mismatch' })

    const stored = await pool.query<{ project_name: string }>(
      `
        SELECT p.name AS project_name
        FROM agent_sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE s.id = $1::uuid
      `,
      [session.id]
    )
    expect(stored.rows).toEqual([{ project_name: 'Boron Context' }])

    await repository.completeSession({
      sessionId: session.id,
      outcome: 'completed',
      summary: 'Cross-project resume was rejected without changing session ownership.',
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

function fixtureAdapter(
  layer: 'ontology' | 'codebase' | 'wiki',
  sourceType: 'ontology' | 'live' | 'snapshot',
  evidence: readonly Evidence[]
): ContextAdapter {
  return {
    layer,
    name: `${sourceType}-${layer}-fixture`,
    sourceType,
    health: async () => ({ ok: true }),
    search: async () => evidence
  }
}

function coverageEvidence(
  projectId: string,
  id: string,
  metadata: Record<string, unknown> = {},
  uri = `integration://source-coverage-evidence/${id}`
): Evidence {
  return {
    id,
    layer: id.startsWith('live') ? 'codebase' : id.startsWith('snapshot') ? 'wiki' : 'ontology',
    title: id,
    uri,
    excerpt: `Source coverage fixture ${id}`,
    confidence: 1,
    authority: 1,
    projectId,
    metadata
  }
}

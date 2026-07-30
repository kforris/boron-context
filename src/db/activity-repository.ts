import { createHash, randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import type {
  ActivityEvidenceInput,
  CompleteSessionRequest,
  ContextCapsule,
  ContextMeterSummaryRequest,
  EntityReference,
  RecordActivityRequest,
  RelationEffect,
  ResolvedProject,
  StartSessionRequest
} from '../core/contracts.js'

export interface StartedSession {
  readonly id: string
  readonly traceId: string
  readonly intentionId: string
  readonly project: ResolvedProject | null
}

export interface RecordedActivity {
  readonly id: string
  readonly relationEffects: number
  readonly evidence: number
  readonly duplicate: boolean
}

export class PostgresActivityRepository {
  constructor(private readonly pool: Pool) {}

  async startSession(input: StartSessionRequest): Promise<StartedSession> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const project = await ensureProject(client, input)
      const traceId = randomUUID()
      const intention = await client.query<{ id: string }>(
        `
          INSERT INTO intentions (trace_id, project_id, objective, constraints, client)
          VALUES ($1, $2::uuid, $3, $4::jsonb, $5)
          RETURNING id::text
        `,
        [
          traceId,
          project?.id ?? null,
          input.objective,
          JSON.stringify(input.constraints),
          input.client
        ]
      )
      const intentionId = intention.rows[0]!.id
      const session = await client.query<{ id: string }>(
        `
          INSERT INTO agent_sessions (
            external_session_id, client, project_id, intention_id, objective, metadata
          )
          VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6::jsonb)
          ON CONFLICT (client, external_session_id)
          DO UPDATE SET
            objective = EXCLUDED.objective,
            project_id = COALESCE(agent_sessions.project_id, EXCLUDED.project_id),
            metadata = agent_sessions.metadata || EXCLUDED.metadata
          RETURNING id::text
        `,
        [
          input.externalSessionId ?? null,
          input.client,
          project?.id ?? null,
          intentionId,
          input.objective,
          JSON.stringify(input.metadata)
        ]
      )
      const sessionId = session.rows[0]!.id
      await insertActivity(client, {
        sessionId,
        projectId: project?.id ?? null,
        activityType: 'intent.captured',
        summary: input.objective,
        source: input.client,
        confidence: 1,
        payload: { constraints: input.constraints },
        occurredAt: new Date().toISOString()
      })
      await client.query('COMMIT')
      return { id: sessionId, traceId, intentionId, project }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async recordActivity(
    input: RecordActivityRequest,
    source = 'boron-client'
  ): Promise<RecordedActivity> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const session = await loadSession(client, input.sessionId)
      const occurredAt = input.occurredAt ?? new Date().toISOString()
      const activity = await insertActivity(client, {
        sessionId: input.sessionId,
        projectId: session.projectId,
        activityType: input.activityType,
        summary: input.summary,
        source,
        ...(input.actorUri ? { actorUri: input.actorUri } : {}),
        ...(input.targetUri ? { targetUri: input.targetUri } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        confidence: input.confidence,
        payload: input.metadata,
        occurredAt
      })
      if (activity.duplicate) {
        await client.query('COMMIT')
        return { id: activity.id, relationEffects: 0, evidence: 0, duplicate: true }
      }

      for (const effect of input.relationEffects) {
        await applyRelationEffect(client, activity.id, session.projectId, occurredAt, effect)
      }
      let evidenceCount = 0
      await insertEvidence(client, activity.id, session.projectId, {
        layer: 'ontology',
        title: `Activity: ${input.activityType}`,
        excerpt: input.summary,
        confidence: input.confidence,
        authority: 0.8,
        metadata: {
          activityId: activity.id,
          actorUri: input.actorUri,
          targetUri: input.targetUri,
          occurredAt
        }
      })
      evidenceCount += 1
      for (const item of input.evidence) {
        await insertEvidence(client, activity.id, session.projectId, item)
        evidenceCount += 1
      }
      await client.query('COMMIT')
      return {
        id: activity.id,
        relationEffects: input.relationEffects.length,
        evidence: evidenceCount,
        duplicate: false
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async completeSession(
    input: CompleteSessionRequest,
    source = 'boron-client'
  ): Promise<RecordedActivity> {
    const evidence: ActivityEvidenceInput[] = [
      {
        layer: 'wiki',
        title: `Session outcome: ${input.outcome}`,
        excerpt: [
          input.summary,
          ...(input.decisions.length > 0
            ? ['', 'Decisions:', ...input.decisions.map((decision) => `- ${decision}`)]
            : [])
        ].join('\n'),
        confidence: input.outcome === 'completed' ? 0.95 : 0.8,
        authority: 0.85,
        metadata: { decisions: input.decisions, outcome: input.outcome }
      },
      ...input.evidence
    ]
    const recorded = await this.recordActivity(
      {
        sessionId: input.sessionId,
        activityType: `session.${input.outcome}`,
        summary: input.summary,
        confidence: 1,
        metadata: input.metadata,
        relationEffects: input.relationEffects,
        evidence
      },
      source
    )
    await this.pool.query(
      `
        UPDATE agent_sessions
        SET status = $2, ended_at = now(), metadata = metadata || $3::jsonb
        WHERE id = $1::uuid
      `,
      [input.sessionId, input.outcome, JSON.stringify(input.metadata)]
    )
    return recorded
  }

  async saveCapsule(input: {
    readonly session: StartedSession
    readonly capsule: ContextCapsule
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO context_capsules (
          id, trace_id, intention_id, project_id, token_budget,
          estimated_tokens, truncated, payload
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        input.capsule.id,
        input.capsule.traceId,
        input.session.intentionId,
        input.session.project?.id ?? null,
        input.capsule.tokenBudget,
        input.capsule.estimatedTokens,
        input.capsule.truncated,
        JSON.stringify(input.capsule)
      ]
    )
    await this.pool.query(
      `UPDATE intentions SET status = 'resolved', updated_at = now() WHERE id = $1::uuid`,
      [input.session.intentionId]
    )
    await this.saveMeter(input.capsule)
  }

  async saveMeter(capsule: ContextCapsule): Promise<void> {
    const meter = capsule.meter
    await this.pool.query(
      `
        INSERT INTO context_meter_samples (
          capsule_id, trace_id, project_id, client,
          candidate_evidence_count, selected_evidence_count,
          candidate_tokens, capsule_tokens, filtered_tokens,
          recovered_context_tokens, source_estimate_covered_evidence,
          source_tokens, source_excerpt_tokens, source_compression_tokens,
          retrieval_latency_ms, boron_llm_provider, boron_llm_model,
          boron_llm_calls, boron_llm_input_tokens, boron_llm_output_tokens,
          token_estimator
        )
        VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4,
          $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21
        )
        ON CONFLICT (capsule_id) DO NOTHING
      `,
      [
        capsule.id,
        capsule.traceId,
        capsule.project?.id ?? null,
        meter.client,
        meter.candidateEvidenceCount,
        meter.selectedEvidenceCount,
        meter.candidateTokens,
        meter.capsuleTokens,
        meter.filteredTokens,
        meter.recoveredContextTokens,
        meter.sourceEstimateCoveredEvidence,
        meter.sourceTokens,
        meter.sourceExcerptTokens,
        meter.sourceCompressionTokens,
        meter.retrievalLatencyMs,
        meter.boronLlm.provider,
        meter.boronLlm.model,
        meter.boronLlm.calls,
        meter.boronLlm.inputTokens,
        meter.boronLlm.outputTokens,
        meter.tokenEstimator
      ]
    )
  }

  async contextMeterSummary(input: ContextMeterSummaryRequest): Promise<{
    readonly windowDays: number
    readonly project: string | null
    readonly samples: number
    readonly candidateTokens: number
    readonly capsuleTokens: number
    readonly filteredTokens: number
    readonly selectionReductionRatio: number
    readonly recoveredContextTokens: number
    readonly manualReentryEquivalentMinutes: number
    readonly typingWordsPerMinute: number
    readonly sourceEstimateCoveredEvidence: number
    readonly sourceTokens: number
    readonly sourceExcerptTokens: number
    readonly sourceCompressionTokens: number
    readonly sourceCompressionRatio: number | null
    readonly averageRetrievalLatencyMs: number
    readonly boronLlm: {
      readonly provider: 'none'
      readonly model: 'none'
      readonly calls: 0
      readonly inputTokens: 0
      readonly outputTokens: 0
    }
    readonly caveats: readonly string[]
  }> {
    const result = await this.pool.query<{
      samples: string
      candidate_tokens: string
      capsule_tokens: string
      filtered_tokens: string
      recovered_context_tokens: string
      source_estimate_covered_evidence: string
      source_tokens: string
      source_excerpt_tokens: string
      source_compression_tokens: string
      average_retrieval_latency_ms: string | null
      boron_llm_calls: string
      boron_llm_input_tokens: string
      boron_llm_output_tokens: string
    }>(
      `
        SELECT
          count(*)::text AS samples,
          coalesce(sum(m.candidate_tokens), 0)::text AS candidate_tokens,
          coalesce(sum(m.capsule_tokens), 0)::text AS capsule_tokens,
          coalesce(sum(m.filtered_tokens), 0)::text AS filtered_tokens,
          coalesce(sum(m.recovered_context_tokens), 0)::text AS recovered_context_tokens,
          coalesce(sum(m.source_estimate_covered_evidence), 0)::text
            AS source_estimate_covered_evidence,
          coalesce(sum(m.source_tokens), 0)::text AS source_tokens,
          coalesce(sum(m.source_excerpt_tokens), 0)::text AS source_excerpt_tokens,
          coalesce(sum(m.source_compression_tokens), 0)::text AS source_compression_tokens,
          round(avg(m.retrieval_latency_ms), 2)::text AS average_retrieval_latency_ms,
          coalesce(sum(m.boron_llm_calls), 0)::text AS boron_llm_calls,
          coalesce(sum(m.boron_llm_input_tokens), 0)::text AS boron_llm_input_tokens,
          coalesce(sum(m.boron_llm_output_tokens), 0)::text AS boron_llm_output_tokens
        FROM context_meter_samples m
        LEFT JOIN projects p ON p.id = m.project_id
        WHERE m.created_at >= now() - make_interval(days => $1)
          AND (
            $2::text IS NULL
            OR lower(p.name) = lower($2)
            OR p.source_uri = $2
            OR lower(p.name) LIKE '%' || lower($2) || '%'
          )
      `,
      [input.windowDays, input.projectHint ?? null]
    )
    const row = result.rows[0]!
    const candidateTokens = Number(row.candidate_tokens)
    const capsuleTokens = Number(row.capsule_tokens)
    const recoveredContextTokens = Number(row.recovered_context_tokens)
    const sourceTokens = Number(row.source_tokens)
    const sourceCompressionTokens = Number(row.source_compression_tokens)
    return {
      windowDays: input.windowDays,
      project: input.projectHint ?? null,
      samples: Number(row.samples),
      candidateTokens,
      capsuleTokens,
      filteredTokens: Number(row.filtered_tokens),
      selectionReductionRatio:
        candidateTokens > 0 ? Number(row.filtered_tokens) / candidateTokens : 0,
      recoveredContextTokens,
      manualReentryEquivalentMinutes: (recoveredContextTokens * 0.75) / input.typingWordsPerMinute,
      typingWordsPerMinute: input.typingWordsPerMinute,
      sourceEstimateCoveredEvidence: Number(row.source_estimate_covered_evidence),
      sourceTokens,
      sourceExcerptTokens: Number(row.source_excerpt_tokens),
      sourceCompressionTokens,
      sourceCompressionRatio: sourceTokens > 0 ? sourceCompressionTokens / sourceTokens : null,
      averageRetrievalLatencyMs: Number(row.average_retrieval_latency_ms ?? 0),
      boronLlm: {
        provider: 'none',
        model: 'none',
        calls: 0,
        inputTokens: 0,
        outputTokens: 0
      },
      caveats: [
        'Recovered context tokens approximate context the user did not need to retype; they are still sent to the agent model.',
        'Filtered tokens measure candidate excerpts omitted by Boron, not the size of repositories or documents the agent might otherwise inspect.',
        'Source compression is reported only when evidence includes a sourceTokenEstimate.',
        'Manual re-entry time is an equivalent at the supplied typing speed, not observed human time.'
      ]
    }
  }
}

async function ensureProject(
  client: PoolClient,
  input: StartSessionRequest
): Promise<ResolvedProject | null> {
  if (!input.projectRoot) return null
  const root = resolve(input.projectRoot)
  const sourceUri = pathToFileURL(root).href
  const name = input.projectHint ?? basename(root)
  const result = await client.query<{ id: string; name: string }>(
    `
      INSERT INTO projects (name, source_uri, status, metadata)
      VALUES ($1, $2, 'confirmed', $3::jsonb)
      ON CONFLICT (source_uri)
      DO UPDATE SET
        name = EXCLUDED.name,
        status = 'confirmed',
        metadata = projects.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING id::text, name
    `,
    [name, sourceUri, JSON.stringify({ localRoot: root, selectedByClient: input.client })]
  )
  return { id: result.rows[0]!.id, name: result.rows[0]!.name, confidence: 1 }
}

async function loadSession(
  client: PoolClient,
  sessionId: string
): Promise<{ readonly projectId: string | null }> {
  const result = await client.query<{ project_id: string | null }>(
    'SELECT project_id::text FROM agent_sessions WHERE id = $1::uuid',
    [sessionId]
  )
  if (!result.rows[0]) throw new Error(`Unknown Boron session: ${sessionId}`)
  return { projectId: result.rows[0].project_id }
}

async function insertActivity(
  client: PoolClient,
  input: {
    readonly sessionId: string
    readonly projectId: string | null
    readonly activityType: string
    readonly summary: string
    readonly source: string
    readonly actorUri?: string
    readonly targetUri?: string
    readonly idempotencyKey?: string
    readonly confidence: number
    readonly payload: Readonly<Record<string, unknown>>
    readonly occurredAt: string
  }
): Promise<{ readonly id: string; readonly duplicate: boolean }> {
  if (input.idempotencyKey) {
    const existing = await client.query<{ id: string }>(
      'SELECT id::text FROM activities WHERE source = $1 AND idempotency_key = $2',
      [input.source, input.idempotencyKey]
    )
    if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true }
  }
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO activities (
        session_id, project_id, activity_type, actor_uri, target_uri, summary,
        source, idempotency_key, confidence, payload, occurred_at
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz
      )
      RETURNING id::text
    `,
    [
      input.sessionId,
      input.projectId,
      input.activityType,
      input.actorUri ?? null,
      input.targetUri ?? null,
      input.summary,
      input.source,
      input.idempotencyKey ?? null,
      input.confidence,
      JSON.stringify(input.payload),
      input.occurredAt
    ]
  )
  return { id: result.rows[0]!.id, duplicate: false }
}

async function applyRelationEffect(
  client: PoolClient,
  activityId: string,
  projectId: string | null,
  effectiveAt: string,
  effect: RelationEffect
): Promise<void> {
  const subjectId = await ensureObject(client, projectId, effect.subject)
  const targetId = await ensureObject(client, projectId, effect.target)
  const provenance = {
    activityId,
    rationale: effect.rationale,
    modelProposed: effect.confirmationState === 'candidate'
  }
  await client.query(
    `
      INSERT INTO relation_effects (
        activity_id, source_object_id, relation_type, target_object_id, operation,
        confidence, confirmation_state, effective_at, provenance
      )
      VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8::timestamptz, $9::jsonb)
    `,
    [
      activityId,
      subjectId,
      effect.relationType,
      targetId,
      effect.operation,
      effect.confidence,
      effect.confirmationState,
      effectiveAt,
      JSON.stringify(provenance)
    ]
  )
  if (effect.operation === 'retract') {
    await client.query(
      `
        UPDATE relations
        SET valid_to = $4::timestamptz, updated_at = now()
        WHERE source_object_id = $1::uuid
          AND relation_type = $2
          AND target_object_id = $3::uuid
          AND valid_to IS NULL
      `,
      [subjectId, effect.relationType, targetId, effectiveAt]
    )
    return
  }
  const existing = await client.query<{ id: string }>(
    `
      SELECT id::text
      FROM relations
      WHERE source_object_id = $1::uuid
        AND relation_type = $2
        AND target_object_id = $3::uuid
        AND valid_to IS NULL
      ORDER BY version DESC
      LIMIT 1
    `,
    [subjectId, effect.relationType, targetId]
  )
  if (existing.rows[0]) {
    await client.query(
      `
        UPDATE relations
        SET
          confidence = GREATEST(confidence, $2),
          confirmation_state = CASE
            WHEN confirmation_state = 'confirmed' THEN 'confirmed'
            ELSE $3
          END,
          provenance = provenance || $4::jsonb,
          asserted_by_activity_id = $5::uuid,
          updated_at = now()
        WHERE id = $1::uuid
      `,
      [
        existing.rows[0].id,
        effect.confidence,
        effect.confirmationState,
        JSON.stringify(provenance),
        activityId
      ]
    )
    return
  }
  const version = await client.query<{ next_version: number }>(
    `
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM relations
      WHERE source_object_id = $1::uuid
        AND relation_type = $2
        AND target_object_id = $3::uuid
    `,
    [subjectId, effect.relationType, targetId]
  )
  await client.query(
    `
      INSERT INTO relations (
        source_object_id, relation_type, target_object_id, confidence,
        confirmation_state, provenance, version, valid_from, asserted_by_activity_id
      )
      VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::uuid)
    `,
    [
      subjectId,
      effect.relationType,
      targetId,
      effect.confidence,
      effect.confirmationState,
      JSON.stringify(provenance),
      Number(version.rows[0]?.next_version ?? 1),
      effectiveAt,
      activityId
    ]
  )
}

async function ensureObject(
  client: PoolClient,
  projectId: string | null,
  entity: EntityReference
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO objects (project_id, kind, name, canonical_uri, confirmation_state)
      VALUES ($1::uuid, $2, $3, $4, 'candidate')
      ON CONFLICT (canonical_uri)
      DO UPDATE SET
        project_id = COALESCE(objects.project_id, EXCLUDED.project_id),
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        updated_at = now()
      RETURNING id::text
    `,
    [projectId, entity.kind, entity.name, entity.canonicalUri]
  )
  return result.rows[0]!.id
}

async function insertEvidence(
  client: PoolClient,
  activityId: string,
  projectId: string | null,
  input: ActivityEvidenceInput
): Promise<void> {
  const uri = input.uri ?? `boron://activity/${activityId}/evidence/${randomUUID()}`
  const contentHash = createHash('sha256').update(`${input.title}\n${input.excerpt}`).digest('hex')
  await client.query(
    `
      INSERT INTO evidence (
        project_id, layer, title, uri, excerpt, confidence, authority,
        content_hash, metadata
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (layer, uri, content_hash)
      DO UPDATE SET
        confidence = GREATEST(evidence.confidence, EXCLUDED.confidence),
        authority = GREATEST(evidence.authority, EXCLUDED.authority),
        metadata = evidence.metadata || EXCLUDED.metadata,
        updated_at = now()
    `,
    [
      projectId,
      input.layer,
      input.title,
      uri,
      input.excerpt,
      input.confidence,
      input.authority,
      contentHash,
      JSON.stringify({
        ...input.metadata,
        ...(input.sourceTokenEstimate ? { sourceTokenEstimate: input.sourceTokenEstimate } : {}),
        activityId
      })
    ]
  )
}

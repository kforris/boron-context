import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import type {
  ActivityEvidenceInput,
  CompleteSessionRequest,
  ContextCapsule,
  ContextMeterAuditRequest,
  ContextMeterEvidenceAudit,
  ContextMeterSummaryRequest,
  EntityReference,
  RecordActivityRequest,
  RelationEffect,
  ResolvedProject,
  StartSessionRequest
} from '../core/contracts.js'
import { resolveProjectIdentity } from './project-identity.js'

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

export interface ContextMeterSummary {
  readonly windowDays: number
  readonly project: string | null
  readonly samples: number
  readonly candidateTokens: number
  readonly capsuleTokens: number
  readonly filteredTokens: number
  readonly selectionReductionRatio: number
  readonly reExplanation: {
    readonly evidenceCount: number
    readonly avoidedTokens: number
    readonly manualReentryEquivalentMinutes: number
    readonly typingWordsPerMinute: number
    readonly basis: 'selected_prior_activity_excerpt'
  }
  readonly sourceWindow: {
    readonly status: 'not_covered' | 'measured_partial' | 'measured_full'
    readonly measuredSamples: number
    readonly selectedEvidenceCount: number
    readonly coveredEvidenceCount: number
    readonly coverageRatio: number
    readonly originalTokens: number | null
    readonly capsuleTokens: number | null
    readonly savingsTokens: number | null
    readonly savingsRatio: number | null
  }
  readonly averageRetrievalLatencyMs: number
  readonly boronLlm: {
    readonly provider: 'none'
    readonly model: 'none'
    readonly calls: 0
    readonly inputTokens: 0
    readonly outputTokens: 0
  }
  readonly caveats: readonly string[]
}

export interface ContextMeterAuditSample {
  readonly id: string
  readonly capsuleId: string
  readonly traceId: string
  readonly project: string | null
  readonly client: string
  readonly createdAt: string
  readonly retrievalPlan: ContextCapsule['retrievalPlan']
  readonly candidateEvidenceCount: number
  readonly selectedEvidenceCount: number
  readonly candidateTokens: number
  readonly capsuleTokens: number
  readonly filteredTokens: number
  readonly reExplanationAvoidedTokens: number
  readonly sourceWindowStatus: ContextCapsule['meter']['sourceWindowStatus']
  readonly sourceWindowCoveredEvidenceCount: number
  readonly sourceWindowOriginalTokens: number | null
  readonly sourceWindowCapsuleTokens: number | null
  readonly sourceWindowSavingsTokens: number | null
  readonly retrievalLatencyMs: number
  readonly evidence: readonly ContextMeterEvidenceAudit[]
}

interface AuditEvidenceRow {
  readonly meter_sample_id: string
  readonly evidence_id: string
  readonly layer: ContextMeterEvidenceAudit['layer']
  readonly title: string
  readonly uri: string
  readonly adapter_name: string
  readonly adapter_source_type: ContextMeterEvidenceAudit['sourceType']
  readonly stage_id: string
  readonly candidate_tokens: number
  readonly selected: boolean
  readonly score: number
  readonly source_token_estimate: number | null
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
    readonly evidenceAudit?: readonly ContextMeterEvidenceAudit[]
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
    await this.saveMeter(input.capsule, input.evidenceAudit ?? [])
  }

  async saveMeter(
    capsule: ContextCapsule,
    evidenceAudit: readonly ContextMeterEvidenceAudit[] = []
  ): Promise<void> {
    const meter = capsule.meter
    const sample = await this.pool.query<{ id: string }>(
      `
        INSERT INTO context_meter_samples (
          capsule_id, trace_id, project_id, client,
          candidate_evidence_count, selected_evidence_count,
          candidate_tokens, capsule_tokens, filtered_tokens,
          recovered_context_tokens, source_estimate_covered_evidence,
          source_tokens, source_excerpt_tokens, source_compression_tokens,
          retrieval_latency_ms, boron_llm_provider, boron_llm_model,
          boron_llm_calls, boron_llm_input_tokens, boron_llm_output_tokens,
          token_estimator, re_explanation_evidence_count,
          re_explanation_avoided_tokens, source_window_status,
          source_window_selected_evidence_count,
          source_window_covered_evidence_count, source_window_original_tokens,
          source_window_capsule_tokens, source_window_savings_tokens, retrieval_plan
        )
        VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4,
          $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30::jsonb
        )
        ON CONFLICT (capsule_id)
        DO UPDATE SET
          retrieval_plan = EXCLUDED.retrieval_plan,
          re_explanation_evidence_count = EXCLUDED.re_explanation_evidence_count,
          re_explanation_avoided_tokens = EXCLUDED.re_explanation_avoided_tokens,
          source_window_status = EXCLUDED.source_window_status,
          source_window_selected_evidence_count = EXCLUDED.source_window_selected_evidence_count,
          source_window_covered_evidence_count = EXCLUDED.source_window_covered_evidence_count,
          source_window_original_tokens = EXCLUDED.source_window_original_tokens,
          source_window_capsule_tokens = EXCLUDED.source_window_capsule_tokens,
          source_window_savings_tokens = EXCLUDED.source_window_savings_tokens
        RETURNING id::text
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
        meter.reExplanationAvoidedTokens,
        meter.sourceWindowCoveredEvidenceCount,
        meter.sourceWindowOriginalTokens ?? 0,
        meter.sourceWindowCapsuleTokens ?? 0,
        meter.sourceWindowSavingsTokens ?? 0,
        meter.retrievalLatencyMs,
        meter.boronLlm.provider,
        meter.boronLlm.model,
        meter.boronLlm.calls,
        meter.boronLlm.inputTokens,
        meter.boronLlm.outputTokens,
        meter.tokenEstimator,
        meter.reExplanationEvidenceCount,
        meter.reExplanationAvoidedTokens,
        meter.sourceWindowStatus,
        meter.sourceWindowSelectedEvidenceCount,
        meter.sourceWindowCoveredEvidenceCount,
        meter.sourceWindowOriginalTokens,
        meter.sourceWindowCapsuleTokens,
        meter.sourceWindowSavingsTokens,
        JSON.stringify(capsule.retrievalPlan)
      ]
    )
    const sampleId = sample.rows[0]?.id
    if (!sampleId || evidenceAudit.length === 0) return
    await this.pool.query(
      `
        INSERT INTO context_meter_evidence_samples (
          meter_sample_id, evidence_id, layer, title, uri, adapter_name,
          adapter_source_type, stage_id, candidate_tokens, selected, score,
          source_token_estimate
        )
        SELECT
          $1::uuid,
          item->>'evidenceId',
          item->>'layer',
          item->>'title',
          item->>'uri',
          item->>'adapter',
          item->>'sourceType',
          item->>'stageId',
          (item->>'candidateTokens')::integer,
          (item->>'selected')::boolean,
          (item->>'score')::numeric,
          CASE
            WHEN item->'sourceTokenEstimate' = 'null'::jsonb THEN NULL
            ELSE (item->>'sourceTokenEstimate')::integer
          END
        FROM jsonb_array_elements($2::jsonb) item
        ON CONFLICT (meter_sample_id, evidence_id, uri, stage_id, adapter_name)
        DO UPDATE SET
          selected = EXCLUDED.selected,
          score = EXCLUDED.score,
          source_token_estimate = EXCLUDED.source_token_estimate
      `,
      [sampleId, JSON.stringify(evidenceAudit)]
    )
  }

  async contextMeterSummary(input: ContextMeterSummaryRequest): Promise<ContextMeterSummary> {
    const result = await this.pool.query<{
      samples: string
      candidate_tokens: string
      capsule_tokens: string
      filtered_tokens: string
      re_explanation_evidence_count: string
      re_explanation_avoided_tokens: string
      source_window_measured_samples: string
      source_window_selected_evidence_count: string
      source_window_covered_evidence_count: string
      source_window_original_tokens: string
      source_window_capsule_tokens: string
      source_window_savings_tokens: string
      average_retrieval_latency_ms: string | null
    }>(
      `
        SELECT
          count(*)::text AS samples,
          coalesce(sum(m.candidate_tokens), 0)::text AS candidate_tokens,
          coalesce(sum(m.capsule_tokens), 0)::text AS capsule_tokens,
          coalesce(sum(m.filtered_tokens), 0)::text AS filtered_tokens,
          coalesce(sum(m.re_explanation_evidence_count), 0)::text
            AS re_explanation_evidence_count,
          coalesce(sum(m.re_explanation_avoided_tokens), 0)::text
            AS re_explanation_avoided_tokens,
          count(*) FILTER (WHERE m.source_window_status <> 'not_covered')::text
            AS source_window_measured_samples,
          coalesce(sum(m.source_window_selected_evidence_count), 0)::text
            AS source_window_selected_evidence_count,
          coalesce(sum(m.source_window_covered_evidence_count), 0)::text
            AS source_window_covered_evidence_count,
          coalesce(sum(m.source_window_original_tokens), 0)::text
            AS source_window_original_tokens,
          coalesce(sum(m.source_window_capsule_tokens), 0)::text
            AS source_window_capsule_tokens,
          coalesce(sum(m.source_window_savings_tokens), 0)::text
            AS source_window_savings_tokens,
          round(avg(m.retrieval_latency_ms), 2)::text AS average_retrieval_latency_ms
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
    const reExplanationAvoidedTokens = Number(row.re_explanation_avoided_tokens)
    const sourceSelected = Number(row.source_window_selected_evidence_count)
    const sourceCovered = Number(row.source_window_covered_evidence_count)
    const sourceOriginal = Number(row.source_window_original_tokens)
    const sourceCapsule = Number(row.source_window_capsule_tokens)
    const sourceSavings = Number(row.source_window_savings_tokens)
    return {
      windowDays: input.windowDays,
      project: input.projectHint ?? null,
      samples: Number(row.samples),
      candidateTokens,
      capsuleTokens,
      filteredTokens: Number(row.filtered_tokens),
      selectionReductionRatio:
        candidateTokens > 0 ? Number(row.filtered_tokens) / candidateTokens : 0,
      reExplanation: {
        evidenceCount: Number(row.re_explanation_evidence_count),
        avoidedTokens: reExplanationAvoidedTokens,
        manualReentryEquivalentMinutes:
          (reExplanationAvoidedTokens * 0.75) / input.typingWordsPerMinute,
        typingWordsPerMinute: input.typingWordsPerMinute,
        basis: 'selected_prior_activity_excerpt'
      },
      sourceWindow: {
        status:
          sourceCovered === 0
            ? 'not_covered'
            : sourceCovered === sourceSelected
              ? 'measured_full'
              : 'measured_partial',
        measuredSamples: Number(row.source_window_measured_samples),
        selectedEvidenceCount: sourceSelected,
        coveredEvidenceCount: sourceCovered,
        coverageRatio: sourceSelected > 0 ? sourceCovered / sourceSelected : 0,
        originalTokens: sourceCovered > 0 ? sourceOriginal : null,
        capsuleTokens: sourceCovered > 0 ? sourceCapsule : null,
        savingsTokens: sourceCovered > 0 ? sourceSavings : null,
        savingsRatio:
          sourceCovered > 0 && sourceOriginal > 0 ? sourceSavings / sourceOriginal : null
      },
      averageRetrievalLatencyMs: Number(row.average_retrieval_latency_ms ?? 0),
      boronLlm: {
        provider: 'none',
        model: 'none',
        calls: 0,
        inputTokens: 0,
        outputTokens: 0
      },
      caveats: [
        'Re-explanation avoided tokens count selected excerpts from prior verified Boron activities; those capsule tokens still enter the agent model.',
        'Filtered tokens measure candidate excerpts omitted by Boron, not the size of repositories or documents the agent might otherwise inspect.',
        'Source-window savings are calculated only for selected evidence with a recorded sourceTokenEstimate; uncovered evidence is excluded and coverage is shown.',
        'Manual re-entry time is an equivalent at the supplied typing speed, not observed human time.'
      ]
    }
  }

  async contextMeterAudit(input: ContextMeterAuditRequest): Promise<{
    readonly summary: ContextMeterSummary
    readonly samples: readonly ContextMeterAuditSample[]
  }> {
    const summary = await this.contextMeterSummary(input)
    const samples = await this.pool.query<{
      id: string
      capsule_id: string
      trace_id: string
      project_name: string | null
      client: string
      created_at: Date
      retrieval_plan: ContextCapsule['retrievalPlan']
      candidate_evidence_count: number
      selected_evidence_count: number
      candidate_tokens: number
      capsule_tokens: number
      filtered_tokens: number
      re_explanation_avoided_tokens: number
      source_window_status: ContextCapsule['meter']['sourceWindowStatus']
      source_window_covered_evidence_count: number
      source_window_original_tokens: number | null
      source_window_capsule_tokens: number | null
      source_window_savings_tokens: number | null
      retrieval_latency_ms: number
    }>(
      `
        SELECT
          m.id::text,
          m.capsule_id::text,
          m.trace_id::text,
          p.name AS project_name,
          m.client,
          m.created_at,
          m.retrieval_plan,
          m.candidate_evidence_count,
          m.selected_evidence_count,
          m.candidate_tokens,
          m.capsule_tokens,
          m.filtered_tokens,
          m.re_explanation_avoided_tokens,
          m.source_window_status,
          m.source_window_covered_evidence_count,
          m.source_window_original_tokens,
          m.source_window_capsule_tokens,
          m.source_window_savings_tokens,
          m.retrieval_latency_ms
        FROM context_meter_samples m
        LEFT JOIN projects p ON p.id = m.project_id
        WHERE m.created_at >= now() - make_interval(days => $1)
          AND (
            $2::text IS NULL
            OR lower(p.name) = lower($2)
            OR p.source_uri = $2
            OR lower(p.name) LIKE '%' || lower($2) || '%'
          )
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [input.windowDays, input.projectHint ?? null, input.limit]
    )
    const sampleIds = samples.rows.map((row) => row.id)
    const evidence =
      sampleIds.length === 0
        ? { rows: [] as AuditEvidenceRow[] }
        : await this.pool.query<AuditEvidenceRow>(
            `
              SELECT
                meter_sample_id::text,
                evidence_id,
                layer,
                title,
                uri,
                adapter_name,
                adapter_source_type,
                stage_id,
                candidate_tokens,
                selected,
                score,
                source_token_estimate
              FROM context_meter_evidence_samples
              WHERE meter_sample_id = ANY($1::uuid[])
              ORDER BY meter_sample_id, selected DESC, score DESC, title
            `,
            [sampleIds]
          )
    const evidenceBySample = new Map<string, ContextMeterEvidenceAudit[]>()
    for (const row of evidence.rows) {
      const items = evidenceBySample.get(row.meter_sample_id) ?? []
      items.push({
        evidenceId: row.evidence_id,
        layer: row.layer,
        title: row.title,
        uri: redactAuditUri(row.uri),
        adapter: row.adapter_name,
        sourceType: row.adapter_source_type,
        stageId: row.stage_id,
        candidateTokens: Number(row.candidate_tokens),
        selected: row.selected,
        score: Number(row.score),
        sourceTokenEstimate:
          row.source_token_estimate === null ? null : Number(row.source_token_estimate)
      })
      evidenceBySample.set(row.meter_sample_id, items)
    }
    return {
      summary,
      samples: samples.rows.map((row) => ({
        id: row.id,
        capsuleId: row.capsule_id,
        traceId: row.trace_id,
        project: row.project_name,
        client: row.client,
        createdAt: row.created_at.toISOString(),
        retrievalPlan: row.retrieval_plan,
        candidateEvidenceCount: Number(row.candidate_evidence_count),
        selectedEvidenceCount: Number(row.selected_evidence_count),
        candidateTokens: Number(row.candidate_tokens),
        capsuleTokens: Number(row.capsule_tokens),
        filteredTokens: Number(row.filtered_tokens),
        reExplanationAvoidedTokens: Number(row.re_explanation_avoided_tokens),
        sourceWindowStatus: row.source_window_status,
        sourceWindowCoveredEvidenceCount: Number(row.source_window_covered_evidence_count),
        sourceWindowOriginalTokens:
          row.source_window_original_tokens === null
            ? null
            : Number(row.source_window_original_tokens),
        sourceWindowCapsuleTokens:
          row.source_window_capsule_tokens === null
            ? null
            : Number(row.source_window_capsule_tokens),
        sourceWindowSavingsTokens:
          row.source_window_savings_tokens === null
            ? null
            : Number(row.source_window_savings_tokens),
        retrievalLatencyMs: Number(row.retrieval_latency_ms),
        evidence: evidenceBySample.get(row.id) ?? []
      }))
    }
  }
}

export async function ensureProject(
  client: PoolClient,
  input: StartSessionRequest
): Promise<ResolvedProject | null> {
  const hintedProject = await resolveProjectIdentity(client, input.projectHint)
  if (hintedProject) return hintedProject
  if (!input.projectRoot) return null
  const root = resolve(input.projectRoot)
  const sourceUri = pathToFileURL(root).href
  const rootedProject = await resolveProjectIdentity(client, sourceUri)
  if (rootedProject) return rootedProject
  if (root === resolve(homedir())) return null
  const name = input.projectHint ?? basename(root)
  const result = await client.query<{ id: string; name: string }>(
    `
      INSERT INTO projects (name, source_uri, status, metadata)
      VALUES ($1, $2, 'confirmed', $3::jsonb)
      ON CONFLICT (source_uri) DO NOTHING
      RETURNING id::text, name
    `,
    [name, sourceUri, JSON.stringify({ localRoot: root, selectedByClient: input.client })]
  )
  const inserted = result.rows[0]
  const project = inserted ?? (await resolveProjectIdentity(client, sourceUri))
  if (!project) return null
  const projectId = project.id
  for (const alias of new Set([name, basename(root)])) {
    await client.query(
      `
        INSERT INTO project_aliases (
          project_id, alias, normalized_alias, source_uri, confirmation_state
        )
        VALUES ($1::uuid, $2, lower(trim($2)), $3, 'confirmed')
        ON CONFLICT (project_id, normalized_alias)
        DO UPDATE SET
          alias = EXCLUDED.alias,
          source_uri = EXCLUDED.source_uri,
          confirmation_state = 'confirmed',
          updated_at = now()
      `,
      [projectId, alias, sourceUri]
    )
  }
  return { id: projectId, name: project.name, confidence: 1 }
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
  const objectId = result.rows[0]!.id
  await client.query(
    `
      INSERT INTO object_aliases (
        object_id, alias, normalized_alias, source_uri, confirmation_state
      )
      VALUES ($1::uuid, $2, lower(trim($2)), $3, 'candidate')
      ON CONFLICT (object_id, normalized_alias)
      DO UPDATE SET alias = EXCLUDED.alias, source_uri = EXCLUDED.source_uri, updated_at = now()
    `,
    [objectId, entity.name, entity.canonicalUri]
  )
  return objectId
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

function redactAuditUri(uri: string): string {
  try {
    const parsed = new URL(uri)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    return parsed.toString()
  } catch {
    return uri.replace(/([?&](?:token|key|secret|signature)=)[^&#\s]+/gi, '$1[redacted]')
  }
}

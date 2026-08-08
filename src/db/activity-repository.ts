import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import type {
  ActivityEvidenceInput,
  AdoptionHealthRequest,
  AgentClientObservation,
  CompleteSessionRequest,
  ContextCapsule,
  ContextQualityHealthRequest,
  ContextMeterAuditRequest,
  ContextMeterEvidenceAudit,
  ContextMeterSummaryRequest,
  EntityReference,
  LifecycleSessionEndRequest,
  RecordActivityRequest,
  RelationEffect,
  ResolvedProject,
  StartSessionRequest
} from '../core/contracts.js'
import { MAX_FUTURE_ACTIVITY_SKEW_MS } from '../core/contracts.js'
import { ActivityTimestampError, ProjectScopeError } from '../core/errors.js'
import { resolveProjectIdentity } from './project-identity.js'
import { discoverProjectRoot } from '../platform/project-root.js'

export interface StartedSession {
  readonly id: string
  readonly traceId: string
  readonly intentionId: string
  readonly project: ResolvedProject | null
  readonly leaseExpiresAt: string
  readonly resumed: boolean
}

export interface RecordedActivity {
  readonly id: string
  readonly relationEffects: number
  readonly evidence: number
  readonly duplicate: boolean
}

export interface LifecycleSessionEndResult {
  readonly closed: boolean
  readonly sessionId: string | null
  readonly status: 'partial' | null
  readonly reason: 'client_session_end' | 'no_active_session'
}

export interface AdoptionHealthSummary {
  readonly windowDays: number
  readonly observedAgentThreads: number
  readonly contextThreads: number
  readonly sessionThreads: number
  readonly readThreads: number
  readonly uncoveredThreads: number
  readonly observableCoverageRatio: number
  readonly completedSessionThreads: number
  readonly activeSessionThreads: number
  readonly staleActiveSessions: number
  readonly caveats: readonly string[]
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

export interface ContextQualityHealthSummary {
  readonly windowDays: number
  readonly project: string | null
  readonly projectResolution: {
    readonly sessions: number
    readonly scopedSessions: number
    readonly projectlessSessions: number
    readonly resolutionRatio: number
  }
  readonly sessionLifecycle: {
    readonly active: number
    readonly completed: number
    readonly partial: number
    readonly failed: number
    readonly cancelled: number
    readonly staleActive: number
  }
  readonly writebackScope: {
    readonly activities: number
    readonly explicitProject: number
    readonly implicitSession: number
    readonly explicitVerificationRatio: number
  }
  readonly timeIntegrity: {
    readonly futureSkewedActivities: number
    readonly maximumFutureSkewMinutes: number
    readonly allowedFutureSkewMinutes: 5
  }
  readonly sourceCoverage: {
    readonly selectedEvidence: number
    readonly coveredEvidence: number
    readonly coverageRatio: number
  }
  readonly manualCorrections: {
    readonly pending: number
    readonly resolved: number
    readonly dismissed: number
  }
  readonly boronLlmCalls: 0
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
    const session = await this.startSessionInternal(input, false)
    if (!session) throw new Error('Unable to start an unscoped Boron session')
    return session
  }

  async bootstrapSession(input: StartSessionRequest): Promise<StartedSession | null> {
    return this.startSessionInternal(input, true)
  }

  private async startSessionInternal(
    input: StartSessionRequest,
    requireProject: boolean
  ): Promise<StartedSession | null> {
    await this.expireStaleSessions()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const project = await ensureProject(client, input)
      if (!project && requireProject) {
        await client.query('ROLLBACK')
        return null
      }
      if (input.externalSessionId) {
        const existing = await client.query<{
          id: string
          intention_id: string
          trace_id: string
          lease_expires_at: Date
          project_id: string | null
          project_name: string | null
        }>(
          `
            SELECT
              s.id::text,
              s.intention_id::text,
              i.trace_id::text,
              s.lease_expires_at,
              s.project_id::text,
              p.name AS project_name
            FROM agent_sessions s
            JOIN intentions i ON i.id = s.intention_id
            LEFT JOIN projects p ON p.id = s.project_id
            WHERE s.client = $1
              AND s.external_session_id = $2
              AND s.status = 'active'
            FOR UPDATE OF s
            LIMIT 1
          `,
          [input.client, input.externalSessionId]
        )
        const active = existing.rows[0]
        if (active) {
          const lease = await client.query<{ lease_expires_at: Date }>(
            `
              UPDATE agent_sessions
              SET
                project_id = coalesce(project_id, $2::uuid),
                objective = $3,
                metadata = metadata || $4::jsonb,
                last_seen_at = now(),
                lease_duration_minutes = $5,
                lease_expires_at = now() + make_interval(mins => $5)
              WHERE id = $1::uuid
              RETURNING lease_expires_at
            `,
            [
              active.id,
              project?.id ?? null,
              input.objective,
              JSON.stringify(input.metadata),
              input.leaseMinutes
            ]
          )
          await client.query('COMMIT')
          return {
            id: active.id,
            traceId: active.trace_id,
            intentionId: active.intention_id,
            project:
              project ??
              (active.project_id && active.project_name
                ? { id: active.project_id, name: active.project_name, confidence: 1 }
                : null),
            leaseExpiresAt: lease.rows[0]!.lease_expires_at.toISOString(),
            resumed: true
          }
        }
      }
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
      const session = await client.query<{ id: string; lease_expires_at: Date }>(
        `
          INSERT INTO agent_sessions (
            external_session_id, client, project_id, intention_id, objective, metadata,
            last_seen_at, lease_duration_minutes, lease_expires_at
          )
          VALUES (
            $1, $2, $3::uuid, $4::uuid, $5, $6::jsonb,
            now(), $7, now() + make_interval(mins => $7)
          )
          RETURNING id::text, lease_expires_at
        `,
        [
          input.externalSessionId ?? null,
          input.client,
          project?.id ?? null,
          intentionId,
          input.objective,
          JSON.stringify(input.metadata),
          input.leaseMinutes
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
      return {
        id: sessionId,
        traceId,
        intentionId,
        project,
        leaseExpiresAt: session.rows[0]!.lease_expires_at.toISOString(),
        resumed: false
      }
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
      assertActivityTimestamp(occurredAt)
      const writebackScope = input.projectHint
        ? await verifyActivityProjectScope(client, session.projectId, input.projectHint)
        : { verification: 'implicit_session' as const }
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
        payload: { ...input.metadata, writebackScope },
        occurredAt
      })
      if (activity.duplicate) {
        await renewSessionLease(client, input.sessionId, session.leaseDurationMinutes)
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
          occurredAt,
          writebackScope
        }
      })
      evidenceCount += 1
      for (const item of input.evidence) {
        await insertEvidence(client, activity.id, session.projectId, item)
        evidenceCount += 1
      }
      await renewSessionLease(client, input.sessionId, session.leaseDurationMinutes)
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
        SET
          status = $2,
          ended_at = now(),
          last_seen_at = now(),
          closure_reason = 'explicit_completion',
          metadata = metadata || $3::jsonb
        WHERE id = $1::uuid AND status = 'active'
      `,
      [input.sessionId, input.outcome, JSON.stringify(input.metadata)]
    )
    return recorded
  }

  async endSessionFromClientLifecycle(
    input: LifecycleSessionEndRequest
  ): Promise<LifecycleSessionEndResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const active = await client.query<{ id: string; project_id: string | null }>(
        `
          SELECT id::text, project_id::text
          FROM agent_sessions
          WHERE client = $1
            AND external_session_id = $2
            AND status = 'active'
          FOR UPDATE
          LIMIT 1
        `,
        [input.client, input.externalSessionId]
      )
      const session = active.rows[0]
      if (!session) {
        await client.query('COMMIT')
        return {
          closed: false,
          sessionId: null,
          status: null,
          reason: 'no_active_session'
        }
      }
      const summary =
        'The client session ended without an explicit verified Boron completion outcome.'
      const activity = await insertActivity(client, {
        sessionId: session.id,
        projectId: session.project_id,
        activityType: 'session.partial',
        summary,
        source: 'boron-client-lifecycle',
        idempotencyKey: `client-session-end:${session.id}`,
        confidence: 1,
        payload: {
          ...input.metadata,
          autoClosed: true,
          closureReason: 'client_session_end'
        },
        occurredAt: new Date().toISOString()
      })
      if (!activity.duplicate) {
        await insertEvidence(client, activity.id, session.project_id, {
          layer: 'ontology',
          title: 'Activity: session.partial',
          excerpt: summary,
          confidence: 1,
          authority: 1,
          metadata: {
            activityId: activity.id,
            closureReason: 'client_session_end'
          }
        })
      }
      await client.query(
        `
          UPDATE agent_sessions
          SET
            status = 'partial',
            ended_at = now(),
            last_seen_at = now(),
            closure_reason = 'client_session_end',
            metadata = metadata || $2::jsonb
          WHERE id = $1::uuid AND status = 'active'
        `,
        [
          session.id,
          JSON.stringify({
            ...input.metadata,
            autoClosed: true,
            closureReason: 'client_session_end'
          })
        ]
      )
      await client.query('COMMIT')
      return {
        closed: true,
        sessionId: session.id,
        status: 'partial',
        reason: 'client_session_end'
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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
    const project = input.projectHint
      ? await resolveProjectIdentity(this.pool, input.projectHint)
      : null
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
            $3::text IS NULL
            OR ($2::uuid IS NOT NULL AND m.project_id = $2::uuid)
          )
      `,
      [input.windowDays, project?.id ?? null, input.projectHint ?? null]
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
      project: project?.name ?? input.projectHint ?? null,
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
    const project = input.projectHint
      ? await resolveProjectIdentity(this.pool, input.projectHint)
      : null
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
            $4::text IS NULL
            OR ($2::uuid IS NOT NULL AND m.project_id = $2::uuid)
          )
        ORDER BY m.created_at DESC
        LIMIT $3
      `,
      [input.windowDays, project?.id ?? null, input.limit, input.projectHint ?? null]
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

  async contextQualityHealth(
    input: ContextQualityHealthRequest
  ): Promise<ContextQualityHealthSummary> {
    const project = input.projectHint
      ? await resolveProjectIdentity(this.pool, input.projectHint)
      : null
    if (input.projectHint && !project) {
      throw new ProjectScopeError(
        'project_unresolved',
        `Context quality project could not be resolved: ${input.projectHint}`
      )
    }
    const parameters: [number, string | null, string | null] = [
      input.windowDays,
      project?.id ?? null,
      input.projectHint ?? null
    ]
    const [sessions, activities, sourceCoverage, corrections] = await Promise.all([
      this.pool.query<{
        sessions: string
        scoped_sessions: string
        projectless_sessions: string
        active: string
        completed: string
        partial: string
        failed: string
        cancelled: string
        stale_active: string
      }>(
        `
          SELECT
            count(*)::text AS sessions,
            count(*) FILTER (WHERE s.project_id IS NOT NULL)::text AS scoped_sessions,
            count(*) FILTER (WHERE s.project_id IS NULL)::text AS projectless_sessions,
            count(*) FILTER (WHERE s.status = 'active')::text AS active,
            count(*) FILTER (WHERE s.status = 'completed')::text AS completed,
            count(*) FILTER (WHERE s.status = 'partial')::text AS partial,
            count(*) FILTER (WHERE s.status = 'failed')::text AS failed,
            count(*) FILTER (WHERE s.status = 'cancelled')::text AS cancelled,
            count(*) FILTER (
              WHERE s.status = 'active' AND s.lease_expires_at <= now()
            )::text AS stale_active
          FROM agent_sessions s
          WHERE s.started_at >= now() - make_interval(days => $1)
            AND ($3::text IS NULL OR s.project_id = $2::uuid)
        `,
        parameters
      ),
      this.pool.query<{
        activities: string
        explicit_project: string
        implicit_session: string
        future_skewed: string
        maximum_future_skew_minutes: string | null
      }>(
        `
          SELECT
            count(*)::text AS activities,
            count(*) FILTER (
              WHERE a.payload #>> '{writebackScope,verification}' = 'explicit_project'
            )::text AS explicit_project,
            count(*) FILTER (
              WHERE coalesce(
                a.payload #>> '{writebackScope,verification}',
                'implicit_session'
              ) = 'implicit_session'
            )::text AS implicit_session,
            count(*) FILTER (
              WHERE a.occurred_at > a.observed_at + interval '5 minutes'
            )::text AS future_skewed,
            round(greatest(
              coalesce(max(extract(epoch FROM (a.occurred_at - a.observed_at)) / 60), 0),
              0
            )::numeric, 2)::text AS maximum_future_skew_minutes
          FROM activities a
          WHERE a.observed_at >= now() - make_interval(days => $1)
            AND ($3::text IS NULL OR a.project_id = $2::uuid)
        `,
        parameters
      ),
      this.pool.query<{
        selected_evidence: string
        covered_evidence: string
      }>(
        `
          SELECT
            coalesce(sum(m.source_window_selected_evidence_count), 0)::text
              AS selected_evidence,
            coalesce(sum(m.source_window_covered_evidence_count), 0)::text
              AS covered_evidence
          FROM context_meter_samples m
          WHERE m.created_at >= now() - make_interval(days => $1)
            AND ($3::text IS NULL OR m.project_id = $2::uuid)
        `,
        parameters
      ),
      this.pool.query<{
        pending: string
        resolved: string
        dismissed: string
      }>(
        `
          SELECT
            count(*) FILTER (WHERE c.status = 'pending')::text AS pending,
            count(*) FILTER (WHERE c.status = 'resolved')::text AS resolved,
            count(*) FILTER (WHERE c.status = 'dismissed')::text AS dismissed
          FROM manual_corrections c
          WHERE $2::text IS NULL OR c.project_id = $1::uuid
        `,
        [project?.id ?? null, input.projectHint ?? null]
      )
    ])
    const sessionRow = sessions.rows[0]!
    const activityRow = activities.rows[0]!
    const sourceRow = sourceCoverage.rows[0]!
    const correctionRow = corrections.rows[0]!
    const sessionCount = Number(sessionRow.sessions)
    const scopedSessions = Number(sessionRow.scoped_sessions)
    const activityCount = Number(activityRow.activities)
    const explicitProject = Number(activityRow.explicit_project)
    const selectedEvidence = Number(sourceRow.selected_evidence)
    const coveredEvidence = Number(sourceRow.covered_evidence)
    return {
      windowDays: input.windowDays,
      project: project?.name ?? null,
      projectResolution: {
        sessions: sessionCount,
        scopedSessions,
        projectlessSessions: Number(sessionRow.projectless_sessions),
        resolutionRatio: sessionCount > 0 ? scopedSessions / sessionCount : 0
      },
      sessionLifecycle: {
        active: Number(sessionRow.active),
        completed: Number(sessionRow.completed),
        partial: Number(sessionRow.partial),
        failed: Number(sessionRow.failed),
        cancelled: Number(sessionRow.cancelled),
        staleActive: Number(sessionRow.stale_active)
      },
      writebackScope: {
        activities: activityCount,
        explicitProject,
        implicitSession: Number(activityRow.implicit_session),
        explicitVerificationRatio: activityCount > 0 ? explicitProject / activityCount : 0
      },
      timeIntegrity: {
        futureSkewedActivities: Number(activityRow.future_skewed),
        maximumFutureSkewMinutes: Number(activityRow.maximum_future_skew_minutes ?? 0),
        allowedFutureSkewMinutes: 5
      },
      sourceCoverage: {
        selectedEvidence,
        coveredEvidence,
        coverageRatio: selectedEvidence > 0 ? coveredEvidence / selectedEvidence : 0
      },
      manualCorrections: {
        pending: Number(correctionRow.pending),
        resolved: Number(correctionRow.resolved),
        dismissed: Number(correctionRow.dismissed)
      },
      boronLlmCalls: 0,
      caveats: [
        'These deterministic indicators audit continuity plumbing and evidence coverage; they do not claim a scalar intelligence score or prove semantic correctness.',
        'Activities created before explicit project verification was introduced are classified as implicit session scope.',
        'Manual correction counts are current totals for the selected scope rather than windowed events.'
      ]
    }
  }

  async observeAgentClient(input: AgentClientObservation): Promise<void> {
    const mode =
      input.event === 'session_started' || input.event === 'session_completed'
        ? 'session'
        : input.event === 'context_read'
          ? 'read'
          : 'none'
    await this.pool.query(
      `
        INSERT INTO agent_client_observations (
          client_instance_id, client, client_version, protocol_version, context_mode,
          session_id, first_context_at, completed_at, metadata
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6::uuid,
          CASE WHEN $5 = 'none' THEN NULL ELSE now() END,
          CASE WHEN $7 = 'session_completed' THEN now() ELSE NULL END,
          $8::jsonb
        )
        ON CONFLICT (client_instance_id)
        DO UPDATE SET
          client = EXCLUDED.client,
          client_version = coalesce(EXCLUDED.client_version, agent_client_observations.client_version),
          protocol_version = coalesce(
            EXCLUDED.protocol_version,
            agent_client_observations.protocol_version
          ),
          context_mode = CASE
            WHEN agent_client_observations.context_mode = 'session' OR EXCLUDED.context_mode = 'session'
              THEN 'session'
            WHEN agent_client_observations.context_mode = 'read' OR EXCLUDED.context_mode = 'read'
              THEN 'read'
            ELSE 'none'
          END,
          session_id = coalesce(EXCLUDED.session_id, agent_client_observations.session_id),
          first_context_at = coalesce(
            agent_client_observations.first_context_at,
            EXCLUDED.first_context_at
          ),
          completed_at = coalesce(EXCLUDED.completed_at, agent_client_observations.completed_at),
          last_seen_at = now(),
          metadata = agent_client_observations.metadata || EXCLUDED.metadata
      `,
      [
        input.clientInstanceId,
        input.client,
        input.clientVersion ?? null,
        input.protocolVersion ?? null,
        mode,
        input.sessionId ?? null,
        input.event,
        JSON.stringify(input.metadata)
      ]
    )
  }

  async adoptionHealth(input: AdoptionHealthRequest): Promise<AdoptionHealthSummary> {
    const result = await this.pool.query<{
      observed: string
      context_threads: string
      session_threads: string
      read_threads: string
      uncovered_threads: string
      completed_session_threads: string
      active_session_threads: string
      stale_active_sessions: string
    }>(
      `
        SELECT
          count(*)::text AS observed,
          count(*) FILTER (WHERE o.context_mode <> 'none')::text AS context_threads,
          count(*) FILTER (WHERE o.context_mode = 'session')::text AS session_threads,
          count(*) FILTER (WHERE o.context_mode = 'read')::text AS read_threads,
          count(*) FILTER (WHERE o.context_mode = 'none')::text AS uncovered_threads,
          count(*) FILTER (WHERE s.status IN ('completed', 'partial', 'failed', 'cancelled'))::text
            AS completed_session_threads,
          count(*) FILTER (WHERE s.status = 'active')::text AS active_session_threads,
          (
            SELECT count(*)::text
            FROM agent_sessions stale
            WHERE stale.status = 'active' AND stale.lease_expires_at <= now()
          ) AS stale_active_sessions
        FROM agent_client_observations o
        LEFT JOIN agent_sessions s ON s.id = o.session_id
        WHERE o.initialized_at >= now() - make_interval(days => $1)
      `,
      [input.windowDays]
    )
    const row = result.rows[0]!
    const observed = Number(row.observed)
    const contextThreads = Number(row.context_threads)
    return {
      windowDays: input.windowDays,
      observedAgentThreads: observed,
      contextThreads,
      sessionThreads: Number(row.session_threads),
      readThreads: Number(row.read_threads),
      uncoveredThreads: Number(row.uncovered_threads),
      observableCoverageRatio: observed > 0 ? contextThreads / observed : 0,
      completedSessionThreads: Number(row.completed_session_threads),
      activeSessionThreads: Number(row.active_session_threads),
      staleActiveSessions: Number(row.stale_active_sessions),
      caveats: [
        'Coverage uses Boron hook or MCP observations as the denominator; agents that never load the plugin remain outside the denominator.',
        'A Codex hook or MCP client instance normally maps to one thread when the shared session identity is available, but other clients may use a different process lifecycle.',
        'Read-only context queries count as covered without creating a durable writeback session.'
      ]
    }
  }

  async expireStaleSessions(limit = 100): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const stale = await client.query<{
        id: string
        project_id: string | null
        lease_expires_at: Date
      }>(
        `
          SELECT id::text, project_id::text, lease_expires_at
          FROM agent_sessions
          WHERE status = 'active' AND lease_expires_at <= now()
          ORDER BY lease_expires_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        `,
        [limit]
      )
      for (const session of stale.rows) {
        const summary = 'Session lease expired without an explicit completion call.'
        const activity = await insertActivity(client, {
          sessionId: session.id,
          projectId: session.project_id,
          activityType: 'session.partial',
          summary,
          source: 'boron-session-sweeper',
          idempotencyKey: `lease-expired:${session.id}`,
          confidence: 1,
          payload: {
            closureReason: 'lease_expired',
            leaseExpiredAt: session.lease_expires_at.toISOString()
          },
          occurredAt: new Date().toISOString()
        })
        if (!activity.duplicate) {
          await insertEvidence(client, activity.id, session.project_id, {
            layer: 'ontology',
            title: 'Activity: session.partial',
            excerpt: summary,
            confidence: 1,
            authority: 1,
            metadata: {
              activityId: activity.id,
              closureReason: 'lease_expired',
              leaseExpiredAt: session.lease_expires_at.toISOString()
            }
          })
        }
        await client.query(
          `
            UPDATE agent_sessions
            SET
              status = 'partial',
              ended_at = now(),
              last_seen_at = now(),
              closure_reason = 'lease_expired',
              metadata = metadata || $2::jsonb
            WHERE id = $1::uuid AND status = 'active'
          `,
          [
            session.id,
            JSON.stringify({
              autoClosed: true,
              closureReason: 'lease_expired',
              leaseExpiredAt: session.lease_expires_at.toISOString()
            })
          ]
        )
      }
      await client.query('COMMIT')
      return stale.rows.length
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

export async function ensureProject(
  client: PoolClient,
  input: StartSessionRequest
): Promise<ResolvedProject | null> {
  const hintedProject = await resolveProjectIdentity(client, input.projectHint)
  if (hintedProject) return hintedProject
  if (input.externalSessionId) {
    const observed = await client.query<{ id: string; name: string }>(
      `
        SELECT p.id::text, p.name
        FROM codex_thread_project_state state
        JOIN projects p ON p.id = state.project_id
        WHERE state.client = $1
          AND state.external_thread_id = $2
          AND state.classification_state = 'confirmed'
          AND p.status = 'confirmed'
        LIMIT 1
      `,
      [input.client, input.externalSessionId]
    )
    if (observed.rows[0]) {
      return { ...observed.rows[0], confidence: 1 }
    }
  }
  if (!input.projectRoot) return null
  const requestedRoot = resolve(input.projectRoot)
  if (requestedRoot === resolve(homedir())) return null
  const discovered = await discoverProjectRoot(requestedRoot)
  const root = discovered.root
  const sourceUri = pathToFileURL(root).href
  const rootedProject = await resolveProjectIdentity(client, sourceUri)
  if (rootedProject) return rootedProject
  const repositoryProject = discovered.repositoryUri
    ? await resolveProjectIdentity(client, discovered.repositoryUri)
    : null
  if (repositoryProject) {
    await client.query(
      `
        UPDATE projects
        SET
          metadata = metadata || jsonb_build_object(
            'repositoryUri', $2::text,
            'observedRoots', (
              SELECT jsonb_agg(DISTINCT value)
              FROM jsonb_array_elements_text(
                coalesce(metadata->'observedRoots', '[]'::jsonb) || to_jsonb($3::text)
              ) value
            )
          ),
          updated_at = now()
        WHERE id = $1::uuid
      `,
      [repositoryProject.id, discovered.repositoryUri, root]
    )
    return repositoryProject
  }
  return null
}

async function loadSession(
  client: PoolClient,
  sessionId: string
): Promise<{ readonly projectId: string | null; readonly leaseDurationMinutes: number }> {
  const result = await client.query<{
    project_id: string | null
    status: string
    lease_duration_minutes: number
  }>(
    `
      SELECT project_id::text, status, lease_duration_minutes
      FROM agent_sessions
      WHERE id = $1::uuid
      FOR UPDATE
    `,
    [sessionId]
  )
  if (!result.rows[0]) throw new Error(`Unknown Boron session: ${sessionId}`)
  if (result.rows[0].status !== 'active') {
    throw new Error(`Boron session is already ${result.rows[0].status}: ${sessionId}`)
  }
  return {
    projectId: result.rows[0].project_id,
    leaseDurationMinutes: result.rows[0].lease_duration_minutes
  }
}

async function verifyActivityProjectScope(
  client: PoolClient,
  sessionProjectId: string | null,
  projectHint: string
): Promise<{
  readonly verification: 'explicit_project'
  readonly projectHint: string
  readonly resolvedProjectId: string
}> {
  const project = await resolveProjectIdentity(client, projectHint)
  if (!project) {
    throw new ProjectScopeError(
      'project_unresolved',
      `Activity target project could not be resolved: ${projectHint}`
    )
  }
  if (!sessionProjectId || project.id !== sessionProjectId) {
    throw new ProjectScopeError(
      'project_mismatch',
      `Activity target project ${project.name} does not match the open session`
    )
  }
  return {
    verification: 'explicit_project',
    projectHint,
    resolvedProjectId: project.id
  }
}

function assertActivityTimestamp(occurredAt: string, observedAtMs = Date.now()): void {
  const occurredAtMs = Date.parse(occurredAt)
  if (!Number.isFinite(occurredAtMs)) {
    throw new ActivityTimestampError('occurredAt must be a valid ISO 8601 timestamp')
  }
  if (occurredAtMs > observedAtMs + MAX_FUTURE_ACTIVITY_SKEW_MS) {
    throw new ActivityTimestampError('occurredAt cannot be more than 5 minutes in the future')
  }
}

async function renewSessionLease(
  client: PoolClient,
  sessionId: string,
  leaseDurationMinutes: number
): Promise<void> {
  await client.query(
    `
      UPDATE agent_sessions
      SET
        last_seen_at = now(),
        lease_expires_at = now() + make_interval(mins => $2)
      WHERE id = $1::uuid AND status = 'active'
    `,
    [sessionId, leaseDurationMinutes]
  )
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
  const subjectId = await ensureObject(
    client,
    projectId,
    effect.subject,
    effect.confirmationState,
    activityId
  )
  const targetId = await ensureObject(
    client,
    projectId,
    effect.target,
    effect.confirmationState,
    activityId
  )
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
  entity: EntityReference,
  confirmationState: 'candidate' | 'confirmed',
  activityId: string
): Promise<string> {
  const metadata =
    confirmationState === 'confirmed'
      ? {
          confirmationAuthority: 'confirmed_relation_endpoint',
          confirmedByActivityId: activityId
        }
      : {}
  const result = await client.query<{ id: string; confirmation_state: string }>(
    `
      INSERT INTO objects (project_id, kind, name, canonical_uri, confirmation_state, metadata)
      VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (canonical_uri)
      DO UPDATE SET
        project_id = COALESCE(objects.project_id, EXCLUDED.project_id),
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        confirmation_state = CASE
          WHEN objects.confirmation_state = 'rejected' THEN 'rejected'
          WHEN EXCLUDED.confirmation_state = 'confirmed' THEN 'confirmed'
          ELSE objects.confirmation_state
        END,
        metadata = objects.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING id::text, confirmation_state
    `,
    [
      projectId,
      entity.kind,
      entity.name,
      entity.canonicalUri,
      confirmationState,
      JSON.stringify(metadata)
    ]
  )
  const object = result.rows[0]!
  if (object.confirmation_state === 'rejected') {
    throw new Error(`Cannot assert a relation with rejected entity: ${entity.canonicalUri}`)
  }
  const objectId = object.id
  await client.query(
    `
      INSERT INTO object_aliases (
        object_id, alias, normalized_alias, source_uri, confirmation_state, metadata
      )
      VALUES ($1::uuid, $2, lower(trim($2)), $3, $4, $5::jsonb)
      ON CONFLICT (object_id, normalized_alias)
      DO UPDATE SET
        alias = EXCLUDED.alias,
        source_uri = EXCLUDED.source_uri,
        confirmation_state = CASE
          WHEN object_aliases.confirmation_state = 'rejected' THEN 'rejected'
          WHEN EXCLUDED.confirmation_state = 'confirmed' THEN 'confirmed'
          ELSE object_aliases.confirmation_state
        END,
        metadata = object_aliases.metadata || EXCLUDED.metadata,
        updated_at = now()
    `,
    [objectId, entity.name, entity.canonicalUri, confirmationState, JSON.stringify(metadata)]
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

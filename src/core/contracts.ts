import { z } from 'zod'

export const MAX_FUTURE_ACTIVITY_SKEW_MS = 5 * 60 * 1_000

export const contextLayerSchema = z.enum(['ontology', 'codebase', 'wiki'])
export type ContextLayer = z.infer<typeof contextLayerSchema>

export const inspectorScopeSchema = z.object({
  projectHint: z.string().trim().min(1).max(1_000).optional()
})
export type InspectorScope = z.infer<typeof inspectorScopeSchema>

export const spatialCodebaseGraphRequestSchema = z.object({
  project: z.string().trim().min(1).max(1_000)
})
export type SpatialCodebaseGraphRequest = z.infer<typeof spatialCodebaseGraphRequestSchema>

export const spatialCodebaseExpandRequestSchema = spatialCodebaseGraphRequestSchema.extend({
  symbol: z.string().trim().min(1).max(2_000)
})
export type SpatialCodebaseExpandRequest = z.infer<typeof spatialCodebaseExpandRequestSchema>

export const manualCorrectionSchema = z
  .object({
    projectHint: z.string().trim().min(1).max(1_000).optional(),
    layer: contextLayerSchema,
    subjectKind: z.string().trim().min(1).max(200),
    subjectId: z.string().trim().min(1).max(2_000).optional(),
    subjectUri: z.string().trim().min(1).max(4_000),
    fields: z
      .record(z.string().trim().min(1).max(200), z.string().trim().max(20_000))
      .refine((fields) => Object.keys(fields).length <= 30, 'At most 30 fields may be corrected')
      .default({}),
    note: z.string().trim().max(20_000).default('')
  })
  .refine(
    (input) => Object.keys(input.fields).length > 0 || input.note.length > 0,
    'A manual correction requires at least one changed field or a note'
  )
export type ManualCorrectionInput = z.infer<typeof manualCorrectionSchema>

export const listManualCorrectionsSchema = inspectorScopeSchema.extend({
  layer: contextLayerSchema.optional(),
  status: z.enum(['pending', 'resolved', 'dismissed']).default('pending'),
  limit: z.number().int().min(1).max(200).default(100)
})
export type ListManualCorrectionsInput = z.infer<typeof listManualCorrectionsSchema>

export const resolveManualCorrectionSchema = z.object({
  correctionId: z.string().uuid(),
  outcome: z.enum(['resolved', 'dismissed']),
  summary: z.string().trim().min(1).max(20_000),
  resolvedBy: z.string().trim().min(1).max(200).default('agent')
})
export type ResolveManualCorrectionInput = z.infer<typeof resolveManualCorrectionSchema>

export const adapterSourceTypeSchema = z.enum(['ontology', 'snapshot', 'live'])
export type AdapterSourceType = z.infer<typeof adapterSourceTypeSchema>

export const retrievalPurposeSchema = z.enum([
  'locate',
  'policy',
  'code',
  'knowledge',
  'continuity'
])
export type RetrievalPurpose = z.infer<typeof retrievalPurposeSchema>

export const retrievalStageSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().positive(),
  layer: contextLayerSchema,
  purpose: retrievalPurposeSchema,
  reason: z.string().min(1),
  trigger: z.string().min(1),
  status: z.enum(['executed', 'unavailable', 'failed']),
  adapters: z.array(
    z.object({
      name: z.string().min(1),
      sourceType: adapterSourceTypeSchema,
      status: z.enum(['succeeded', 'failed', 'fallback']),
      detail: z.string().optional()
    })
  ),
  candidateEvidenceCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative()
})
export type RetrievalStage = z.infer<typeof retrievalStageSchema>

export const retrievalPlanSchema = z.object({
  version: z.literal(1),
  strategy: z.literal('ontology_first'),
  riskClass: z.enum(['standard', 'high']),
  signals: z.array(z.string()),
  sourceAnchors: z.array(z.string()),
  stages: z.array(retrievalStageSchema)
})
export type RetrievalPlan = z.infer<typeof retrievalPlanSchema>

export const evidenceSchema = z.object({
  id: z.string().min(1),
  layer: contextLayerSchema,
  title: z.string().min(1),
  uri: z.string().min(1),
  excerpt: z.string().min(1),
  confidence: z.number().min(0).max(1),
  authority: z.number().min(0).max(1).default(0.5),
  updatedAt: z.string().datetime().optional(),
  contentHash: z.string().optional(),
  projectId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type Evidence = z.infer<typeof evidenceSchema>

export const contextMeterSchema = z.object({
  version: z.literal(2),
  basis: z.literal('deterministic_estimate'),
  client: z.string(),
  candidateEvidenceCount: z.number().int().nonnegative(),
  selectedEvidenceCount: z.number().int().nonnegative(),
  candidateTokens: z.number().int().nonnegative(),
  capsuleTokens: z.number().int().nonnegative(),
  filteredTokens: z.number().int().nonnegative(),
  selectionReductionRatio: z.number().min(0).max(1),
  reExplanationEvidenceCount: z.number().int().nonnegative(),
  reExplanationAvoidedTokens: z.number().int().nonnegative(),
  sourceWindowStatus: z.enum(['not_covered', 'measured_partial', 'measured_full']),
  sourceWindowSelectedEvidenceCount: z.number().int().nonnegative(),
  sourceWindowCoveredEvidenceCount: z.number().int().nonnegative(),
  sourceWindowCoverageRatio: z.number().min(0).max(1),
  sourceWindowOriginalTokens: z.number().int().nonnegative().nullable(),
  sourceWindowCapsuleTokens: z.number().int().nonnegative().nullable(),
  sourceWindowSavingsTokens: z.number().int().nonnegative().nullable(),
  sourceWindowSavingsRatio: z.number().min(0).max(1).nullable(),
  retrievalLatencyMs: z.number().int().nonnegative(),
  tokenEstimator: z.literal('characters_divided_by_4'),
  boronLlm: z.object({
    provider: z.literal('none'),
    model: z.literal('none'),
    calls: z.literal(0),
    inputTokens: z.literal(0),
    outputTokens: z.literal(0)
  })
})
export type ContextMeter = z.infer<typeof contextMeterSchema>

export const resolveContextRequestSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  projectHint: z.string().trim().min(1).max(1_000).optional(),
  objectHints: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  layers: z.array(contextLayerSchema).min(1).max(3).optional(),
  tokenBudget: z.number().int().min(256).max(16_000).default(6_000),
  client: z.string().trim().min(1).max(200).default('unknown'),
  workflow: z.enum(['read', 'session_start']).default('read')
})
export type ResolveContextRequest = z.infer<typeof resolveContextRequestSchema>

export const capsuleEvidenceSchema = evidenceSchema.extend({
  estimatedTokens: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
  retrieval: z.object({
    stageId: z.string().min(1),
    adapter: z.string().min(1),
    sourceType: adapterSourceTypeSchema
  })
})
export type CapsuleEvidence = z.infer<typeof capsuleEvidenceSchema>

export const contextCapsuleSchema = z.object({
  id: z.string().uuid(),
  traceId: z.string().uuid(),
  objective: z.string(),
  project: z
    .object({
      id: z.string(),
      name: z.string(),
      confidence: z.number().min(0).max(1)
    })
    .nullable(),
  constraints: z.array(z.string()),
  evidence: z.array(capsuleEvidenceSchema),
  unresolved: z.array(z.string()),
  layersQueried: z.array(contextLayerSchema),
  retrievalPlan: retrievalPlanSchema,
  estimatedTokens: z.number().int().nonnegative(),
  tokenBudget: z.number().int().positive(),
  truncated: z.boolean(),
  meter: contextMeterSchema,
  createdAt: z.string().datetime()
})
export type ContextCapsule = z.infer<typeof contextCapsuleSchema>

export interface ResolvedProject {
  readonly id: string
  readonly name: string
  readonly confidence: number
}

export const entityReferenceSchema = z.object({
  kind: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(1_000),
  canonicalUri: z.string().trim().min(1).max(4_000)
})
export type EntityReference = z.infer<typeof entityReferenceSchema>

export const relationEffectSchema = z.object({
  subject: entityReferenceSchema,
  relationType: z.string().trim().min(1).max(200),
  target: entityReferenceSchema,
  operation: z.enum(['assert', 'retract']),
  confidence: z.number().min(0).max(1).default(0.7),
  confirmationState: z.enum(['candidate', 'confirmed']).default('candidate'),
  rationale: z.string().trim().min(1).max(4_000)
})
export type RelationEffect = z.infer<typeof relationEffectSchema>

export const activityEvidenceInputSchema = z.object({
  layer: contextLayerSchema,
  title: z.string().trim().min(1).max(1_000),
  uri: z.string().trim().min(1).max(4_000).optional(),
  excerpt: z.string().trim().min(1).max(20_000),
  confidence: z.number().min(0).max(1).default(0.8),
  authority: z.number().min(0).max(1).default(0.7),
  sourceTokenEstimate: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type ActivityEvidenceInput = z.infer<typeof activityEvidenceInputSchema>

export const startSessionRequestSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  projectHint: z.string().trim().min(1).max(1_000).optional(),
  projectRoot: z.string().trim().min(1).max(4_000).optional(),
  externalSessionId: z.string().trim().min(1).max(1_000).optional(),
  client: z.string().trim().min(1).max(200).default('unknown'),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  tokenBudget: z.number().int().min(256).max(16_000).default(4_000),
  leaseMinutes: z.number().int().min(15).max(1_440).default(720),
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>

export const recordActivityRequestSchema = z.object({
  sessionId: z.string().uuid(),
  projectHint: z.string().trim().min(1).max(1_000).optional(),
  activityType: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  actorUri: z.string().trim().min(1).max(4_000).optional(),
  targetUri: z.string().trim().min(1).max(4_000).optional(),
  occurredAt: z
    .string()
    .datetime({ offset: true })
    .refine(
      (value) => Date.parse(value) <= Date.now() + MAX_FUTURE_ACTIVITY_SKEW_MS,
      'occurredAt cannot be more than 5 minutes in the future'
    )
    .optional(),
  idempotencyKey: z.string().trim().min(1).max(1_000).optional(),
  confidence: z.number().min(0).max(1).default(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  relationEffects: z.array(relationEffectSchema).max(50).default([]),
  evidence: z.array(activityEvidenceInputSchema).max(50).default([])
})
export type RecordActivityRequest = z.infer<typeof recordActivityRequestSchema>

export const completeSessionRequestSchema = z.object({
  sessionId: z.string().uuid(),
  outcome: z.enum(['completed', 'failed', 'partial', 'cancelled']),
  summary: z.string().trim().min(1).max(20_000),
  decisions: z.array(z.string().trim().min(1).max(4_000)).max(50).default([]),
  relationEffects: z.array(relationEffectSchema).max(50).default([]),
  evidence: z.array(activityEvidenceInputSchema).max(50).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type CompleteSessionRequest = z.infer<typeof completeSessionRequestSchema>

export const lifecycleSessionEndRequestSchema = z.object({
  externalSessionId: z.string().trim().min(1).max(1_000),
  client: z.string().trim().min(1).max(200).default('codex'),
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type LifecycleSessionEndRequest = z.infer<typeof lifecycleSessionEndRequestSchema>

export const agentClientObservationSchema = z.object({
  clientInstanceId: z.string().trim().min(1).max(1_000),
  client: z.string().trim().min(1).max(200).default('unknown'),
  clientVersion: z.string().trim().min(1).max(200).optional(),
  protocolVersion: z.string().trim().min(1).max(200).optional(),
  event: z.enum(['initialized', 'context_read', 'session_started', 'session_completed']),
  sessionId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type AgentClientObservation = z.infer<typeof agentClientObservationSchema>

export const codexThreadSyncAuthoritySchema = z.enum([
  'user_approved_plan',
  'codex_project_assignment',
  'exact_registered_root',
  'parent_inheritance',
  'candidate'
])
export type CodexThreadSyncAuthority = z.infer<typeof codexThreadSyncAuthoritySchema>

export const codexThreadProjectObservationSchema = z
  .object({
    externalThreadId: z.string().trim().min(1).max(1_000),
    codexProjectId: z.string().trim().min(1).max(1_000).optional(),
    classificationState: z.enum(['confirmed', 'candidate', 'projectless']),
    authority: codexThreadSyncAuthoritySchema,
    confidence: z.number().min(0).max(1),
    evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .superRefine((input, context) => {
    if (input.classificationState === 'confirmed' && !input.codexProjectId) {
      context.addIssue({
        code: 'custom',
        path: ['codexProjectId'],
        message: 'Confirmed thread observations require a Codex project ID'
      })
    }
    if (input.classificationState === 'projectless' && input.codexProjectId) {
      context.addIssue({
        code: 'custom',
        path: ['codexProjectId'],
        message: 'Projectless thread observations cannot carry a Codex project ID'
      })
    }
  })
export type CodexThreadProjectObservation = z.infer<typeof codexThreadProjectObservationSchema>

export const codexThreadSyncRequestSchema = z.object({
  snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
  client: z.string().trim().min(1).max(200).default('codex'),
  source: z.string().trim().min(1).max(200).default('codex_hook'),
  observedAt: z.string().datetime({ offset: true }),
  observations: z.array(codexThreadProjectObservationSchema).max(5_000),
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type CodexThreadSyncRequest = z.infer<typeof codexThreadSyncRequestSchema>

export const adoptionHealthRequestSchema = z.object({
  windowDays: z.number().int().min(1).max(365).default(30)
})
export type AdoptionHealthRequest = z.infer<typeof adoptionHealthRequestSchema>

export const contextMeterSummaryRequestSchema = z.object({
  projectHint: z.string().trim().min(1).max(1_000).optional(),
  windowDays: z.number().int().min(1).max(365).default(30),
  typingWordsPerMinute: z.number().min(10).max(200).default(40)
})
export type ContextMeterSummaryRequest = z.infer<typeof contextMeterSummaryRequestSchema>

export const contextMeterAuditRequestSchema = contextMeterSummaryRequestSchema.extend({
  limit: z.number().int().min(1).max(50).default(10)
})
export type ContextMeterAuditRequest = z.infer<typeof contextMeterAuditRequestSchema>

export const contextQualityHealthRequestSchema = z.object({
  projectHint: z.string().trim().min(1).max(1_000).optional(),
  windowDays: z.number().int().min(1).max(365).default(30)
})
export type ContextQualityHealthRequest = z.infer<typeof contextQualityHealthRequestSchema>

export interface ContextMeterEvidenceAudit {
  readonly evidenceId: string
  readonly layer: ContextLayer
  readonly title: string
  readonly uri: string
  readonly adapter: string
  readonly sourceType: AdapterSourceType
  readonly stageId: string
  readonly candidateTokens: number
  readonly selected: boolean
  readonly score: number
  readonly sourceTokenEstimate: number | null
}

export interface ContextResolution {
  readonly capsule: ContextCapsule
  readonly evidenceAudit: readonly ContextMeterEvidenceAudit[]
}

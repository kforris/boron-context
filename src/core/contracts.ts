import { z } from 'zod'

export const contextLayerSchema = z.enum(['ontology', 'codebase', 'wiki'])
export type ContextLayer = z.infer<typeof contextLayerSchema>

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
  version: z.literal(1),
  basis: z.literal('deterministic_estimate'),
  client: z.string(),
  candidateEvidenceCount: z.number().int().nonnegative(),
  selectedEvidenceCount: z.number().int().nonnegative(),
  candidateTokens: z.number().int().nonnegative(),
  capsuleTokens: z.number().int().nonnegative(),
  filteredTokens: z.number().int().nonnegative(),
  selectionReductionRatio: z.number().min(0).max(1),
  recoveredContextTokens: z.number().int().nonnegative(),
  sourceEstimateCoveredEvidence: z.number().int().nonnegative(),
  sourceTokens: z.number().int().nonnegative(),
  sourceExcerptTokens: z.number().int().nonnegative(),
  sourceCompressionTokens: z.number().int().nonnegative(),
  sourceCompressionRatio: z.number().min(0).max(1).nullable(),
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
  client: z.string().trim().min(1).max(200).default('unknown')
})
export type ResolveContextRequest = z.infer<typeof resolveContextRequestSchema>

export const capsuleEvidenceSchema = evidenceSchema.extend({
  estimatedTokens: z.number().int().nonnegative(),
  score: z.number().min(0).max(1)
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
  metadata: z.record(z.string(), z.unknown()).default({})
})
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>

export const recordActivityRequestSchema = z.object({
  sessionId: z.string().uuid(),
  activityType: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  actorUri: z.string().trim().min(1).max(4_000).optional(),
  targetUri: z.string().trim().min(1).max(4_000).optional(),
  occurredAt: z.string().datetime().optional(),
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

export const contextMeterSummaryRequestSchema = z.object({
  projectHint: z.string().trim().min(1).max(1_000).optional(),
  windowDays: z.number().int().min(1).max(365).default(30),
  typingWordsPerMinute: z.number().min(10).max(200).default(40)
})
export type ContextMeterSummaryRequest = z.infer<typeof contextMeterSummaryRequestSchema>

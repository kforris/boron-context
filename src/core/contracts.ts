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
  createdAt: z.string().datetime()
})
export type ContextCapsule = z.infer<typeof contextCapsuleSchema>

export interface ResolvedProject {
  readonly id: string
  readonly name: string
  readonly confidence: number
}

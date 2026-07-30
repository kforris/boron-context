import { randomUUID } from 'node:crypto'
import type { ContextAdapter } from './context-adapter.js'
import {
  type CapsuleEvidence,
  type ContextCapsule,
  type ContextLayer,
  type Evidence,
  type ResolveContextRequest,
  type ResolvedProject,
  resolveContextRequestSchema
} from './contracts.js'

export interface ProjectResolver {
  resolve(request: ResolveContextRequest): Promise<ResolvedProject | null>
}

export interface ContextResolverOptions {
  readonly adapters: readonly ContextAdapter[]
  readonly projects: ProjectResolver
  readonly now?: () => Date
  readonly perAdapterLimit?: number
  readonly meterNow?: () => number
}

export class ContextResolver {
  private readonly now: () => Date
  private readonly perAdapterLimit: number
  private readonly meterNow: () => number

  constructor(private readonly options: ContextResolverOptions) {
    this.now = options.now ?? (() => new Date())
    this.perAdapterLimit = options.perAdapterLimit ?? 40
    this.meterNow = options.meterNow ?? (() => performance.now())
  }

  async resolve(input: unknown, traceId: string = randomUUID()): Promise<ContextCapsule> {
    const meterStartedAt = this.meterNow()
    const request = resolveContextRequestSchema.parse(input)
    const project = await this.options.projects.resolve(request)
    const selectedAdapters = this.selectAdapters(request.layers)
    const results = await Promise.all(
      selectedAdapters.map((adapter) =>
        adapter.search({
          request,
          projectId: project?.id ?? null,
          limit: this.perAdapterLimit
        })
      )
    )

    const ranked = rankAndDedupe(results.flat(), request, project)
    const packed = packEvidence(ranked, request.tokenBudget)
    const meter = buildContextMeter(
      ranked,
      packed.evidence,
      packed.estimatedTokens,
      request.client,
      Math.max(0, Math.round(this.meterNow() - meterStartedAt))
    )
    const unresolved: string[] = []
    if (request.projectHint && !project) {
      unresolved.push(`Project hint could not be resolved: ${request.projectHint}`)
    }
    if (!request.projectHint && !project) {
      unresolved.push(
        'No project was resolved; confirm the target project before durable writeback.'
      )
    }

    return {
      id: randomUUID(),
      traceId,
      objective: request.objective,
      project,
      constraints: request.constraints,
      evidence: packed.evidence,
      unresolved,
      layersQueried: selectedAdapters.map((adapter) => adapter.layer),
      estimatedTokens: packed.estimatedTokens,
      tokenBudget: request.tokenBudget,
      truncated: packed.truncated,
      meter,
      createdAt: this.now().toISOString()
    }
  }

  private selectAdapters(requested?: readonly ContextLayer[]): readonly ContextAdapter[] {
    if (!requested) return this.options.adapters
    const allowed = new Set(requested)
    return this.options.adapters.filter((adapter) => allowed.has(adapter.layer))
  }
}

function buildContextMeter(
  ranked: readonly CapsuleEvidence[],
  selected: readonly CapsuleEvidence[],
  capsuleTokens: number,
  client: string,
  retrievalLatencyMs: number
): ContextCapsule['meter'] {
  const candidateTokens =
    CAPSULE_BASE_TOKENS + ranked.reduce((total, item) => total + item.estimatedTokens, 0)
  const filteredTokens = Math.max(0, candidateTokens - capsuleTokens)
  const recoveredContextTokens = selected
    .filter(
      (item) =>
        typeof item.metadata.activityId === 'string' || item.uri.startsWith('boron://activity/')
    )
    .reduce((total, item) => total + item.estimatedTokens, 0)
  const sourceCovered = selected.filter(
    (item) =>
      typeof item.metadata.sourceTokenEstimate === 'number' &&
      Number.isFinite(item.metadata.sourceTokenEstimate) &&
      item.metadata.sourceTokenEstimate > 0
  )
  const sourceTokens = sourceCovered.reduce(
    (total, item) => total + Number(item.metadata.sourceTokenEstimate),
    0
  )
  const sourceExcerptTokens = sourceCovered.reduce((total, item) => total + item.estimatedTokens, 0)
  const sourceCompressionTokens = Math.max(0, sourceTokens - sourceExcerptTokens)
  return {
    version: 1,
    basis: 'deterministic_estimate',
    client,
    candidateEvidenceCount: ranked.length,
    selectedEvidenceCount: selected.length,
    candidateTokens,
    capsuleTokens,
    filteredTokens,
    selectionReductionRatio: candidateTokens > 0 ? filteredTokens / candidateTokens : 0,
    recoveredContextTokens,
    sourceEstimateCoveredEvidence: sourceCovered.length,
    sourceTokens,
    sourceExcerptTokens,
    sourceCompressionTokens,
    sourceCompressionRatio: sourceTokens > 0 ? sourceCompressionTokens / sourceTokens : null,
    retrievalLatencyMs,
    tokenEstimator: 'characters_divided_by_4',
    boronLlm: {
      provider: 'none',
      model: 'none',
      calls: 0,
      inputTokens: 0,
      outputTokens: 0
    }
  }
}

function rankAndDedupe(
  evidence: readonly Evidence[],
  request: ResolveContextRequest,
  project: ResolvedProject | null
): readonly CapsuleEvidence[] {
  const terms = queryTerms(
    [
      request.objective,
      request.projectHint ?? '',
      ...request.objectHints,
      ...request.constraints
    ].join(' ')
  )
  const byIdentity = new Map<string, CapsuleEvidence>()

  for (const item of evidence) {
    const identity = `${item.layer}:${item.uri}:${item.contentHash ?? ''}`
    const relevance = lexicalRelevance(terms, `${item.title} ${item.excerpt}`)
    const projectMatch = !project || !item.projectId ? 0.5 : item.projectId === project.id ? 1 : 0
    const score = clamp(
      item.confidence * 0.35 + item.authority * 0.25 + relevance * 0.3 + projectMatch * 0.1
    )
    const candidate: CapsuleEvidence = {
      ...item,
      estimatedTokens: estimateTokens(`${item.title}\n${item.excerpt}\n${item.uri}`),
      score
    }
    const existing = byIdentity.get(identity)
    if (!existing || candidate.score > existing.score) byIdentity.set(identity, candidate)
  }

  return [...byIdentity.values()].sort(
    (left, right) => right.score - left.score || left.uri.localeCompare(right.uri)
  )
}

function packEvidence(
  ranked: readonly CapsuleEvidence[],
  tokenBudget: number
): {
  readonly evidence: CapsuleEvidence[]
  readonly estimatedTokens: number
  readonly truncated: boolean
} {
  let used = CAPSULE_BASE_TOKENS
  const selected: CapsuleEvidence[] = []
  for (const item of ranked) {
    if (used + item.estimatedTokens > tokenBudget) continue
    selected.push(item)
    used += item.estimatedTokens
  }
  return {
    evidence: selected,
    estimatedTokens: used,
    truncated: selected.length < ranked.length
  }
}

const CAPSULE_BASE_TOKENS = 180

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function queryTerms(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length > 1)
  )
}

function lexicalRelevance(terms: ReadonlySet<string>, text: string): number {
  if (terms.size === 0) return 0.5
  const haystack = text.toLowerCase()
  let matches = 0
  for (const term of terms) if (haystack.includes(term)) matches += 1
  return clamp(matches / Math.min(terms.size, 8))
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

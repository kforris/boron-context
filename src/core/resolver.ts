import { randomUUID } from 'node:crypto'
import type { ContextAdapter } from './context-adapter.js'
import {
  type AdapterSourceType,
  type CapsuleEvidence,
  type ContextCapsule,
  type ContextLayer,
  type ContextMeterEvidenceAudit,
  type ContextResolution,
  type Evidence,
  type ResolveContextRequest,
  type ResolvedProject,
  type RetrievalPlan,
  type RetrievalPurpose,
  type RetrievalStage,
  resolveContextRequestSchema
} from './contracts.js'
import { classifySourceCoverage, summarizeSourceCoverage } from './source-coverage.js'

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

interface PlannedStage {
  readonly id: string
  readonly layer: ContextLayer
  readonly purpose: RetrievalPurpose
  readonly reason: string
  readonly trigger: string
}

type SourcedEvidence = Evidence & {
  readonly retrieval: {
    readonly stageId: string
    readonly adapter: string
    readonly sourceType: AdapterSourceType
  }
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
    return (await this.resolveWithAudit(input, traceId)).capsule
  }

  async resolveWithAudit(
    input: unknown,
    traceId: string = randomUUID()
  ): Promise<ContextResolution> {
    const meterStartedAt = this.meterNow()
    const request = resolveContextRequestSchema.parse(input)
    const project = await this.options.projects.resolve(request)
    const blueprint = buildRetrievalBlueprint(request)
    const stages: RetrievalStage[] = []
    const candidates: SourcedEvidence[] = []
    const unresolved: string[] = []

    for (const planned of blueprint.stages) {
      const stageStartedAt = this.meterNow()
      const adapters = this.adaptersForStage(planned)
      const attempts: RetrievalStage['adapters'][number][] = []
      let stageEvidenceCount = 0
      let stageStatus: RetrievalStage['status'] = 'unavailable'
      let liveAttempted = false
      let liveSucceeded = false

      for (const adapter of adapters) {
        if (adapter.sourceType === 'snapshot' && liveSucceeded) break
        if (adapter.sourceType === 'live') liveAttempted = true
        try {
          const evidence = await adapter.search({
            request,
            projectId: project?.id ?? null,
            resolvedProjectName: project?.name ?? null,
            limit: this.perAdapterLimit,
            stageId: planned.id,
            purpose: planned.purpose,
            sourceAnchors: blueprint.sourceAnchors
          })
          for (const item of evidence) {
            if (project && item.projectId && item.projectId !== project.id) continue
            candidates.push({
              ...item,
              retrieval: {
                stageId: planned.id,
                adapter: adapter.name,
                sourceType: adapter.sourceType
              }
            })
          }
          stageEvidenceCount += evidence.length
          stageStatus = 'executed'
          attempts.push({
            name: adapter.name,
            sourceType: adapter.sourceType,
            status: adapter.sourceType === 'snapshot' && liveAttempted ? 'fallback' : 'succeeded'
          })
          if (planned.layer === 'ontology') break
          if (adapter.sourceType === 'live') {
            liveSucceeded = true
            continue
          }
          break
        } catch {
          if (stageStatus !== 'executed') stageStatus = 'failed'
          attempts.push({
            name: adapter.name,
            sourceType: adapter.sourceType,
            status: 'failed',
            detail: 'search failed'
          })
        }
      }

      if (adapters.length === 0) {
        unresolved.push(`No ${planned.layer} adapter is connected for stage ${planned.id}.`)
      } else if (stageStatus === 'failed') {
        unresolved.push(`All ${planned.layer} adapters failed for stage ${planned.id}.`)
      }
      if (planned.purpose === 'policy' && stageEvidenceCount === 0) {
        unresolved.push(
          'High-risk intent detected, but no matching confirmed policy evidence was found.'
        )
      }

      stages.push({
        ...planned,
        order: stages.length + 1,
        status: stageStatus,
        adapters: attempts,
        candidateEvidenceCount: stageEvidenceCount,
        latencyMs: Math.max(0, Math.round(this.meterNow() - stageStartedAt))
      })
    }

    const retrievalPlan: RetrievalPlan = {
      version: 1,
      strategy: 'ontology_first',
      riskClass: blueprint.riskClass,
      signals: blueprint.signals,
      sourceAnchors: blueprint.sourceAnchors,
      stages
    }
    const ranked = rankAndDedupe(candidates, request, project, blueprint.sourceAnchors)
    const packed = packEvidence(ranked, request.tokenBudget)
    const meter = buildContextMeter(
      ranked,
      packed.evidence,
      packed.estimatedTokens,
      request.client,
      Math.max(0, Math.round(this.meterNow() - meterStartedAt))
    )

    if (request.projectHint && !project) {
      unresolved.push(`Project hint could not be resolved: ${request.projectHint}`)
    }
    if (!request.projectHint && !project) {
      unresolved.push(
        'No project was resolved; confirm the target project before durable writeback.'
      )
    }

    const capsule: ContextCapsule = {
      id: randomUUID(),
      traceId,
      objective: request.objective,
      project,
      constraints: request.constraints,
      evidence: packed.evidence,
      unresolved,
      layersQueried: uniqueLayers(stages),
      retrievalPlan,
      estimatedTokens: packed.estimatedTokens,
      tokenBudget: request.tokenBudget,
      truncated: packed.truncated,
      meter,
      createdAt: this.now().toISOString()
    }
    finalizeWireTokenMeter(capsule, ranked)
    return { capsule, evidenceAudit: buildEvidenceAudit(ranked, packed.evidence) }
  }

  private adaptersForStage(stage: PlannedStage): readonly ContextAdapter[] {
    const matching = this.options.adapters
      .filter((adapter) => adapter.layer === stage.layer)
      .sort((left, right) => left.name.localeCompare(right.name))
    if (stage.layer === 'ontology') return matching.slice(0, 1)

    const live = matching.filter((adapter) => adapter.sourceType === 'live')
    const snapshots = matching.filter((adapter) => adapter.sourceType === 'snapshot')
    return live.length > 0 ? [...live, ...snapshots.slice(0, 1)] : snapshots.slice(0, 1)
  }
}

export function buildRetrievalPlan(input: unknown): Omit<RetrievalPlan, 'stages'> & {
  readonly stages: readonly PlannedStage[]
} {
  const request = resolveContextRequestSchema.parse(input)
  return buildRetrievalBlueprint(request)
}

function buildRetrievalBlueprint(request: ResolveContextRequest): {
  readonly strategy: 'ontology_first'
  readonly riskClass: 'standard' | 'high'
  readonly signals: string[]
  readonly sourceAnchors: string[]
  readonly stages: PlannedStage[]
  readonly version: 1
} {
  const text = [request.objective, ...request.objectHints, ...request.constraints].join(' ')
  const sourceAnchors = extractSourceAnchors(text, request.objectHints)
  const highRisk = hasHighRiskIntent(request)
  const codeSignal =
    matchesAny(text, CODE_PATTERNS) || sourceAnchors.some((anchor) => isCodeAnchor(anchor))
  const wikiSignal =
    matchesAny(text, WIKI_PATTERNS) ||
    sourceAnchors.some(
      (anchor) => isMarkdownAnchor(anchor) || (anchor.startsWith('http') && !isCodeAnchor(anchor))
    )
  const continuitySignal =
    request.workflow === 'session_start' || matchesAny(text, CONTINUITY_PATTERNS)
  const signals = [
    ...(highRisk ? ['high_risk'] : []),
    ...(codeSignal ? ['code'] : []),
    ...(wikiSignal ? ['wiki'] : []),
    ...(continuitySignal ? ['continuity'] : []),
    ...(sourceAnchors.length > 0 ? ['source_anchor'] : []),
    ...(request.layers ? ['explicit_layers'] : [])
  ]
  const stages: PlannedStage[] = [
    {
      id: 'ontology-locate',
      layer: 'ontology',
      purpose: 'locate',
      reason:
        'Resolve project scope, aliases, entities, source anchors, relations, and policy refs.',
      trigger: 'always'
    }
  ]

  if (highRisk) {
    stages.push({
      id: 'ontology-policy',
      layer: 'ontology',
      purpose: 'policy',
      reason: 'Retrieve confirmed policy evidence before any high-risk source expansion.',
      trigger: 'high_risk'
    })
  }

  const requested = request.layers ? new Set(request.layers) : null
  const wantsCodebase = requested ? requested.has('codebase') : codeSignal
  const wantsWiki = requested ? requested.has('wiki') : wikiSignal || continuitySignal

  if (wantsCodebase) {
    stages.push({
      id: 'codebase-source',
      layer: 'codebase',
      purpose: 'code',
      reason: 'Resolve requested code paths, symbols, repository relationships, and code evidence.',
      trigger: requested ? 'explicit_layers' : 'code_or_source_anchor'
    })
  }
  if (wantsWiki) {
    stages.push({
      id: continuitySignal ? 'wiki-continuity' : 'wiki-knowledge',
      layer: 'wiki',
      purpose: continuitySignal ? 'continuity' : 'knowledge',
      reason: continuitySignal
        ? 'Recover verified recent outcomes, decisions, and operational continuity.'
        : 'Resolve requested document titles, URLs, explanations, and operational knowledge.',
      trigger: requested ? 'explicit_layers' : continuitySignal ? 'continuity' : 'wiki_or_url'
    })
  }

  return {
    version: 1,
    strategy: 'ontology_first',
    riskClass: highRisk ? 'high' : 'standard',
    signals,
    sourceAnchors,
    stages
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
  const reExplanation = selected.filter(isPriorActivityEvidence)
  const reExplanationAvoidedTokens = reExplanation.reduce(
    (total, item) => total + item.estimatedTokens,
    0
  )
  const sourceCovered = selected.filter((item) => sourceTokenEstimate(item) !== null)
  const eligibility = summarizeSourceCoverage(
    selected
      .map((item) => ({
        selected: true,
        ...classifySourceCoverage(item)
      }))
      .map((item) => ({
        selected: item.selected,
        sourceCoverageStatus: item.status,
        sourceCoverageReason: item.reason
      }))
  )
  const sourceWindowOriginalTokens =
    sourceCovered.length > 0
      ? sourceCovered.reduce((total, item) => total + (sourceTokenEstimate(item) ?? 0), 0)
      : null
  const sourceWindowCapsuleTokens =
    sourceCovered.length > 0
      ? sourceCovered.reduce((total, item) => total + item.estimatedTokens, 0)
      : null
  const sourceWindowSavingsTokens =
    sourceWindowOriginalTokens === null || sourceWindowCapsuleTokens === null
      ? null
      : Math.max(0, sourceWindowOriginalTokens - sourceWindowCapsuleTokens)
  const coverageRatio = selected.length > 0 ? sourceCovered.length / selected.length : 0

  return {
    version: 2,
    basis: 'deterministic_estimate',
    client,
    candidateEvidenceCount: ranked.length,
    selectedEvidenceCount: selected.length,
    candidateTokens,
    capsuleTokens,
    filteredTokens,
    selectionReductionRatio: candidateTokens > 0 ? filteredTokens / candidateTokens : 0,
    reExplanationEvidenceCount: reExplanation.length,
    reExplanationAvoidedTokens,
    sourceWindowStatus:
      sourceCovered.length === 0
        ? 'not_covered'
        : sourceCovered.length === selected.length
          ? 'measured_full'
          : 'measured_partial',
    sourceWindowSelectedEvidenceCount: selected.length,
    sourceWindowCoveredEvidenceCount: sourceCovered.length,
    sourceWindowCoverageRatio: coverageRatio,
    sourceWindowOriginalTokens,
    sourceWindowCapsuleTokens,
    sourceWindowSavingsTokens,
    sourceWindowSavingsRatio:
      sourceWindowOriginalTokens && sourceWindowSavingsTokens !== null
        ? sourceWindowSavingsTokens / sourceWindowOriginalTokens
        : null,
    sourceWindowEligibility: eligibility,
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
  evidence: readonly SourcedEvidence[],
  request: ResolveContextRequest,
  project: ResolvedProject | null,
  sourceAnchors: readonly string[]
): readonly CapsuleEvidence[] {
  const terms = queryTerms(
    [request.objective, ...request.objectHints, ...request.constraints].join(' ')
  )
  const byIdentity = new Map<string, CapsuleEvidence>()

  for (const item of evidence) {
    const identity = `${item.layer}:${item.uri}:${item.contentHash ?? ''}`
    const lexicalScore = lexicalRelevance(terms, `${item.title} ${item.excerpt}`)
    const adapterScore = item.metadata.adapterRelevance
    const relevance =
      typeof adapterScore === 'number' && Number.isFinite(adapterScore)
        ? Math.max(lexicalScore, clamp(adapterScore))
        : lexicalScore
    const projectMatch = !project || !item.projectId ? 0.5 : item.projectId === project.id ? 1 : 0
    const anchorMatch = sourceAnchorRelevance(sourceAnchors, item)
    const ontologyValidation = item.layer === 'ontology' ? 1 : 0
    const score = clamp(
      item.confidence * 0.27 +
        item.authority * 0.22 +
        relevance * 0.23 +
        projectMatch * 0.1 +
        anchorMatch * 0.15 +
        ontologyValidation * 0.03
    )
    const candidate: CapsuleEvidence = {
      ...item,
      estimatedTokens: estimateTokens(
        JSON.stringify({
          ...item,
          score
        })
      ),
      score
    }
    const existing = byIdentity.get(identity)
    if (
      !existing ||
      candidate.score > existing.score ||
      (candidate.retrieval.stageId === 'ontology-policy' &&
        existing.retrieval.stageId !== 'ontology-policy')
    ) {
      byIdentity.set(identity, candidate)
    }
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

function buildEvidenceAudit(
  ranked: readonly CapsuleEvidence[],
  selected: readonly CapsuleEvidence[]
): readonly ContextMeterEvidenceAudit[] {
  const selectedIds = new Set(selected.map(auditIdentity))
  return ranked.map((item) => {
    const coverage = classifySourceCoverage(item)
    return {
      evidenceId: item.id,
      layer: item.layer,
      title: item.title,
      uri: item.uri,
      adapter: item.retrieval.adapter,
      sourceType: item.retrieval.sourceType,
      stageId: item.retrieval.stageId,
      candidateTokens: item.estimatedTokens,
      selected: selectedIds.has(auditIdentity(item)),
      score: item.score,
      sourceTokenEstimate: sourceTokenEstimate(item),
      sourceCoverageStatus: coverage.status,
      sourceCoverageReason: coverage.reason
    }
  })
}

function finalizeWireTokenMeter(capsule: ContextCapsule, ranked: readonly CapsuleEvidence[]): void {
  for (let pass = 0; pass < 3; pass += 1) {
    const capsuleTokens = estimateTokens(JSON.stringify(capsule))
    const candidateTokens = estimateTokens(
      JSON.stringify({
        ...capsule,
        evidence: ranked,
        truncated: false
      })
    )
    const filteredTokens = Math.max(0, candidateTokens - capsuleTokens)
    capsule.meter.candidateTokens = candidateTokens
    capsule.meter.capsuleTokens = capsuleTokens
    capsule.meter.filteredTokens = filteredTokens
    capsule.meter.selectionReductionRatio =
      candidateTokens > 0 ? filteredTokens / candidateTokens : 0
  }
}

function auditIdentity(item: CapsuleEvidence): string {
  return [item.id, item.uri, item.retrieval.stageId, item.retrieval.adapter].join(':')
}

function isPriorActivityEvidence(item: CapsuleEvidence): boolean {
  return typeof item.metadata.activityId === 'string' || item.uri.startsWith('boron://activity/')
}

function sourceTokenEstimate(item: CapsuleEvidence): number | null {
  const value = item.metadata.sourceTokenEstimate
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

function uniqueLayers(stages: readonly RetrievalStage[]): ContextLayer[] {
  return [
    ...new Set(stages.filter((stage) => stage.status === 'executed').map((stage) => stage.layer))
  ]
}

function extractSourceAnchors(text: string, objectHints: readonly string[]): string[] {
  const matches = [
    ...(text.match(/https?:\/\/[^\s"'<>]+/g) ?? []),
    ...(text.match(/(?:file:\/\/|\.\.?\/|\/)[^\s"'<>]+/g) ?? []),
    ...objectHints.filter((hint) => /[:/#.]|\w+\(\)$/.test(hint))
  ]
  return [...new Set(matches.map((value) => value.replace(/[),.;]+$/, '')).filter(Boolean))].slice(
    0,
    50
  )
}

function isCodeAnchor(anchor: string): boolean {
  if (isMarkdownAnchor(anchor)) return false
  return (
    anchor.startsWith('file://') ||
    anchor.startsWith('/') ||
    anchor.startsWith('./') ||
    /github\.com|gitlab\.com|bitbucket\.org/i.test(anchor) ||
    /\.(?:[cm]?[jt]sx?|py|go|rs|swift|java|kt|rb|php|sql|toml|ya?ml|json)(?:[:#?]|$)/i.test(
      anchor
    ) ||
    /::|\w+\.\w+\(\)$/.test(anchor)
  )
}

function isMarkdownAnchor(anchor: string): boolean {
  return /\.md(?:[:#?]|$)/i.test(anchor)
}

function sourceAnchorRelevance(anchors: readonly string[], evidence: Evidence): number {
  if (anchors.length === 0) return 0
  const uri = evidence.uri.toLowerCase()
  const title = evidence.title.toLowerCase()
  for (const anchor of anchors) {
    const normalized = anchor.toLowerCase()
    if (uri === normalized) return 1
    if (uri.includes(normalized) || normalized.includes(uri)) return 0.9
    if (title.includes(normalized)) return 0.75
  }
  return 0
}

const CAPSULE_BASE_TOKENS = 180

const QUERY_STOP_WORDS = new Set([
  'about',
  'after',
  'and',
  'anything',
  'are',
  'before',
  'can',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'into',
  'its',
  'not',
  'only',
  'our',
  'the',
  'project',
  'should',
  'that',
  'their',
  'then',
  'there',
  'these',
  'this',
  'those',
  'what',
  'where',
  'which',
  'with',
  'without',
  'would'
])

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function queryTerms(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length > 1 && !QUERY_STOP_WORDS.has(term))
  )
}

function lexicalRelevance(terms: ReadonlySet<string>, text: string): number {
  if (terms.size === 0) return 0.5
  const haystack = text.toLowerCase()
  let matches = 0
  for (const term of terms) if (haystack.includes(term)) matches += 1
  return clamp(matches / Math.min(terms.size, 8))
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function hasHighRiskIntent(request: ResolveContextRequest): boolean {
  const text = [request.objective, ...request.objectHints].join(' ')
  for (const match of text.matchAll(HIGH_RISK_TERMS)) {
    const index = match.index ?? 0
    const before = text.slice(Math.max(0, index - 100), index)
    const after = text.slice(index + match[0].length, index + match[0].length + 40)
    if (
      isNegatedRiskContext(before) ||
      isReadOnlyRiskContext(before) ||
      isNominalRiskContext(match[0], before, after)
    )
      continue
    return true
  }
  return false
}

function isNominalRiskContext(term: string, before: string, after: string): boolean {
  if (term.toLocaleLowerCase('en-US') !== 'release') return false
  if (/\b(?:prepare|ship|create|make|start|perform|initiate|execute)\b[^.!?]{0,60}$/i.test(before))
    return false
  return /^\s*(?:-?\s*candidate\b|readiness\b|notes?\b|checklists?\b|gates?\b|status\b|policy\b|plan\b|version\b)/i.test(
    after
  )
}

function isNegatedRiskContext(before: string): boolean {
  return (
    /\b(?:do not|don't|never|without|no)\s+(?:[\w-]+\s+){0,4}$/i.test(before) ||
    /(?:不|不要|无需|禁止|避免)[^，。；！？]{0,10}$/.test(before)
  )
}

function isReadOnlyRiskContext(before: string): boolean {
  const english = before
    .replace(/(?<=\d)\.(?=\d)/g, '')
    .match(
      /\b(?:read|inspect|audit|assess|review|check|evaluate|report|discuss|find|show|summarize|explain|compare)\b([^.!?]{0,70})$/i
    )
  if (english && !/\b(?:and|then|to|before|after)\b/i.test(english[1] ?? '')) return true
  const chinese = before.match(
    /(?:只读|检查|审计|评估|查看|读取|讨论|查找|显示|总结|解释|比较|健康检查)([^，。；！？]{0,24})$/
  )
  return Boolean(chinese && !/(?:并|然后|再|之后|并且)/.test(chinese[1] ?? ''))
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

const HIGH_RISK_TERMS =
  /\b(?:delete|destroy|deploy|production|release|publish|push|credential|secret|payment|purchase|legal|compliance|permission|execute|rotate|revoke|grant|expose)\b|(?:删除|销毁|部署|生产|发布|推送|凭据|密钥|付款|采购|法律|合规|权限|执行|轮换|撤销|授权|暴露)/giu
const CODE_PATTERNS = [
  /\b(code|repo(?:sitory)?|implement|fix|test|typecheck|symbol|function|class|api|migration|typescript|swift|database)\b/i,
  /(代码|仓库|实现|修复|测试|类型检查|符号|函数|接口|迁移|数据库)/
]
const WIKI_PATTERNS = [
  /\b(document(?:ation|ed)?|docs?|readme|runbook|decision|incident|explain|why|lesson|wiki|vision|goal|roadmap|architecture|design|specification|boundary|lifecycle|security|privacy|install|upgrade|recovery|evaluation|methodology|release notes?)\b/i,
  /(文档|说明|决策|原因|复盘|事故|知识库|愿景|目标|路线图|架构|安全|隐私|安装|升级|恢复|评测|方法论)/
]
const CONTINUITY_PATTERNS = [
  /\b(continue|resume|previous|last time|history|recent|progress|next version|handoff)\b/i,
  /(继续|恢复(?:任务|工作|会话|上下文)|上次|历史|近期|进度|下一版|交接)/
]

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { ProjectMarkdownAdapter } from '../adapters/project-markdown-adapter.js'
import type { ContextAdapter } from '../core/context-adapter.js'
import {
  type Evidence,
  type ResolvedProject,
  resolveContextRequestSchema
} from '../core/contracts.js'
import { ContextResolver } from '../core/resolver.js'

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([])
})
const caseSchema = z.object({
  id: z.string().min(1),
  request: resolveContextRequestSchema,
  expectedProjectId: z.string().min(1),
  relevantPathSuffixes: z.array(z.string().min(1)).min(1),
  forbiddenPathSuffixes: z.array(z.string().min(1)).default([]),
  expectedStageIds: z.array(z.string().min(1)).min(1),
  expectedRiskClass: z.enum(['standard', 'high'])
})
const metricsSchema = z.object({
  recallAt5: z.number().min(0).max(1),
  meanReciprocalRank: z.number().min(0).max(1),
  relevantSourceCoverage: z.number().min(0).max(1),
  routingAccuracy: z.number().min(0).max(1),
  riskClassificationAccuracy: z.number().min(0).max(1),
  wrongProjectRetrieval: z.number().int().nonnegative()
})
const fixtureSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.string().min(1),
  fixtureVersion: z.string().min(1),
  generatedFromPrivateData: z.literal(false),
  projects: z.array(projectSchema).min(1),
  cases: z.array(caseSchema).min(15).max(20)
})
const baselineSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.string().min(1),
  fixtureVersion: z.string().min(1),
  topK: z.literal(5),
  minimum: metricsSchema,
  frozen: metricsSchema
})

export type ProductionShapedFixture = z.infer<typeof fixtureSchema>
export type ProductionShapedBaseline = z.infer<typeof baselineSchema>
export type ProductionShapedMetrics = z.infer<typeof metricsSchema>

export interface ProductionShapedFailure {
  readonly category:
    | 'fixture_integrity'
    | 'project_resolution'
    | 'retrieval_recall'
    | 'retrieval_rank'
    | 'source_coverage'
    | 'routing'
    | 'risk_classification'
    | 'wrong_project_retrieval'
  readonly caseId: string
  readonly detail: string
}

export interface ProductionShapedReport {
  readonly contractVersion: 1
  readonly suite: string
  readonly fixtureVersion: string
  readonly topK: 5
  readonly cases: number
  readonly metrics: ProductionShapedMetrics
  readonly minimum: ProductionShapedMetrics
  readonly frozen: ProductionShapedMetrics
  readonly failures: readonly ProductionShapedFailure[]
  readonly passed: boolean
  readonly deterministic: true
  readonly generatedFromPrivateData: false
  readonly boronLlmCalls: 0
}

export async function loadProductionShapedFixture(path: string): Promise<ProductionShapedFixture> {
  return fixtureSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export async function loadProductionShapedBaseline(
  path: string
): Promise<ProductionShapedBaseline> {
  return baselineSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export async function runProductionShapedEvaluation(
  fixture: ProductionShapedFixture,
  baseline: ProductionShapedBaseline,
  repositoryRoot: string
): Promise<ProductionShapedReport> {
  if (fixture.suite !== baseline.suite || fixture.fixtureVersion !== baseline.fixtureVersion) {
    throw new Error('Fixture and frozen baseline identify different evaluation suites')
  }
  const projects = new Map(fixture.projects.map((project) => [project.id, project]))
  const failures: ProductionShapedFailure[] = []
  let recallTotal = 0
  let reciprocalRankTotal = 0
  let relevantEvidenceTotal = 0
  let coveredRelevantEvidence = 0
  let correctRouting = 0
  let correctRiskClassification = 0
  let wrongProjectRetrieval = 0

  for (const evaluationCase of fixture.cases) {
    const expectedProject = projects.get(evaluationCase.expectedProjectId)
    if (!expectedProject) {
      failures.push({
        category: 'fixture_integrity',
        caseId: evaluationCase.id,
        detail: `unknown expected project ${evaluationCase.expectedProjectId}`
      })
      continue
    }
    const resolver = new ContextResolver({
      projects: { resolve: async (request) => resolveProject(fixture, request.projectHint) },
      adapters: [
        ontologyAdapter(expectedProject.id),
        new ProjectMarkdownAdapter(async (projectId) =>
          projectId === expectedProject.id ? [repositoryRoot] : []
        )
      ],
      now: () => new Date('2026-08-18T00:00:00.000Z'),
      meterNow: () => 0
    })
    const resolution = await resolver.resolveWithAudit(
      evaluationCase.request,
      deterministicTraceId(evaluationCase.id)
    )
    const topFive = resolution.capsule.evidence.slice(0, 5)
    const relevantHits = topFive.filter((item) =>
      evaluationCase.relevantPathSuffixes.some((suffix) => item.uri.endsWith(suffix))
    )
    recallTotal += relevantHits.length / evaluationCase.relevantPathSuffixes.length
    relevantEvidenceTotal += evaluationCase.relevantPathSuffixes.length
    coveredRelevantEvidence += relevantHits.filter(hasSourceEstimate).length
    const firstRelevantRank =
      topFive.findIndex((item) =>
        evaluationCase.relevantPathSuffixes.some((suffix) => item.uri.endsWith(suffix))
      ) + 1
    reciprocalRankTotal += firstRelevantRank > 0 ? 1 / firstRelevantRank : 0

    if (resolution.capsule.project?.id !== evaluationCase.expectedProjectId) {
      failures.push({
        category: 'project_resolution',
        caseId: evaluationCase.id,
        detail: `expected ${evaluationCase.expectedProjectId}; received ${resolution.capsule.project?.id ?? 'null'}`
      })
    }
    const actualStageIds = resolution.capsule.retrievalPlan.stages.map((stage) => stage.id)
    if (JSON.stringify(actualStageIds) === JSON.stringify(evaluationCase.expectedStageIds)) {
      correctRouting += 1
    } else {
      failures.push({
        category: 'routing',
        caseId: evaluationCase.id,
        detail: `expected ${evaluationCase.expectedStageIds.join(',')}; received ${actualStageIds.join(',')}`
      })
    }
    if (resolution.capsule.retrievalPlan.riskClass === evaluationCase.expectedRiskClass) {
      correctRiskClassification += 1
    } else {
      failures.push({
        category: 'risk_classification',
        caseId: evaluationCase.id,
        detail: `expected ${evaluationCase.expectedRiskClass}; received ${resolution.capsule.retrievalPlan.riskClass}`
      })
    }
    for (const item of topFive) {
      const explicitlyWrongProject =
        item.projectId !== undefined && item.projectId !== evaluationCase.expectedProjectId
      const forbiddenPath = evaluationCase.forbiddenPathSuffixes.some((suffix) =>
        item.uri.endsWith(suffix)
      )
      if (!explicitlyWrongProject && !forbiddenPath) continue
      wrongProjectRetrieval += 1
      failures.push({
        category: 'wrong_project_retrieval',
        caseId: evaluationCase.id,
        detail: `forbidden evidence ${item.uri} entered the top 5`
      })
    }
  }

  const metrics: ProductionShapedMetrics = {
    recallAt5: round(recallTotal / fixture.cases.length),
    meanReciprocalRank: round(reciprocalRankTotal / fixture.cases.length),
    relevantSourceCoverage: round(
      relevantEvidenceTotal > 0 ? coveredRelevantEvidence / relevantEvidenceTotal : 0
    ),
    routingAccuracy: round(correctRouting / fixture.cases.length),
    riskClassificationAccuracy: round(correctRiskClassification / fixture.cases.length),
    wrongProjectRetrieval
  }
  applyMetricGates(metrics, baseline.minimum, 'minimum', failures)
  applyMetricGates(metrics, baseline.frozen, 'frozen baseline', failures)

  return {
    contractVersion: 1,
    suite: fixture.suite,
    fixtureVersion: fixture.fixtureVersion,
    topK: 5,
    cases: fixture.cases.length,
    metrics,
    minimum: baseline.minimum,
    frozen: baseline.frozen,
    failures,
    passed: failures.length === 0,
    deterministic: true,
    generatedFromPrivateData: false,
    boronLlmCalls: 0
  }
}

function ontologyAdapter(projectId: string): ContextAdapter {
  const releasePolicy: Evidence = {
    id: 'production-shaped-release-policy',
    layer: 'ontology',
    title: 'Release policy boundary',
    uri: 'boron://policy/release-boundary',
    excerpt: 'Public release and Marketplace submission require separate human approval.',
    confidence: 1,
    authority: 1,
    projectId,
    metadata: { ontologyKind: 'policy' }
  }
  const wrongProjectDecoy: Evidence = {
    id: 'production-shaped-wrong-project',
    layer: 'ontology',
    title: 'Boron Marketing release plan',
    uri: 'boron://marketing/release-plan',
    excerpt: 'Publish a marketing campaign after approval.',
    confidence: 1,
    authority: 1,
    projectId: 'project-boron-marketing',
    metadata: { ontologyKind: 'policy' }
  }
  return {
    layer: 'ontology',
    name: 'production-shaped-ontology',
    sourceType: 'ontology',
    health: async () => ({ ok: true }),
    search: async (input) =>
      input.purpose === 'policy' ? [releasePolicy, wrongProjectDecoy] : [wrongProjectDecoy]
  }
}

function resolveProject(
  fixture: ProductionShapedFixture,
  hint: string | undefined
): ResolvedProject | null {
  if (!hint) return null
  const normalized = hint.trim().toLocaleLowerCase('en-US')
  const match = fixture.projects.find(
    (project) =>
      project.name.toLocaleLowerCase('en-US') === normalized ||
      project.aliases.some((alias) => alias.toLocaleLowerCase('en-US') === normalized)
  )
  return match ? { id: match.id, name: match.name, confidence: 1 } : null
}

function hasSourceEstimate(item: Evidence): boolean {
  const value = item.metadata.sourceTokenEstimate
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function applyMetricGates(
  metrics: ProductionShapedMetrics,
  threshold: ProductionShapedMetrics,
  label: string,
  failures: ProductionShapedFailure[]
): void {
  const minimumMetrics = [
    ['recallAt5', 'retrieval_recall'],
    ['meanReciprocalRank', 'retrieval_rank'],
    ['relevantSourceCoverage', 'source_coverage'],
    ['routingAccuracy', 'routing'],
    ['riskClassificationAccuracy', 'risk_classification']
  ] as const
  for (const [metric, category] of minimumMetrics) {
    if (metrics[metric] >= threshold[metric]) continue
    failures.push({
      category,
      caseId: 'suite',
      detail: `${metric} ${metrics[metric]} is below ${label} ${threshold[metric]}`
    })
  }
  if (metrics.wrongProjectRetrieval <= threshold.wrongProjectRetrieval) return
  failures.push({
    category: 'wrong_project_retrieval',
    caseId: 'suite',
    detail: `wrongProjectRetrieval ${metrics.wrongProjectRetrieval} exceeds ${label} ${threshold.wrongProjectRetrieval}`
  })
}

function deterministicTraceId(caseId: string): string {
  const suffix = Buffer.from(caseId).toString('hex').slice(0, 12).padEnd(12, '0')
  return `00000000-0000-4000-8000-${suffix}`
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function optionValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(`${name} requires a path`)
  return resolve(value ?? fallback)
}

async function main(): Promise<void> {
  const fixturePath = optionValue('--fixture', 'eval/fixtures/continuity-production-shaped.v1.json')
  const baselinePath = optionValue(
    '--baseline',
    'eval/baselines/continuity-production-shaped.v1.json'
  )
  const repositoryRoot = optionValue('--repository-root', '.')
  const [fixture, baseline] = await Promise.all([
    loadProductionShapedFixture(fixturePath),
    loadProductionShapedBaseline(baselinePath)
  ])
  const report = await runProductionShapedEvaluation(fixture, baseline, repositoryRoot)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

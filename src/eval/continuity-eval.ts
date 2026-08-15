#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { ContextAdapter } from '../core/context-adapter.js'
import {
  evidenceSchema,
  resolveContextRequestSchema,
  type Evidence,
  type ResolvedProject
} from '../core/contracts.js'
import { ProjectScopeError } from '../core/errors.js'
import { verifyResolvedActivityProjectScope } from '../core/project-scope.js'
import { ContextResolver } from '../core/resolver.js'

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([])
})

const writebackScopeSchema = z.object({
  sessionProjectId: z.string().nullable(),
  projectHint: z.string().min(1),
  resolvedProjectId: z.string().nullable(),
  expected: z.enum(['accepted', 'project_unresolved', 'project_mismatch'])
})

const evaluationCaseSchema = z.object({
  id: z.string().min(1),
  request: resolveContextRequestSchema,
  expectedProjectId: z.string().min(1),
  relevantEvidenceIds: z.array(z.string().min(1)).min(1),
  forbiddenEvidenceIds: z.array(z.string().min(1)).default([]),
  expectedStageIds: z.array(z.string().min(1)).min(1),
  writebackScope: writebackScopeSchema.optional()
})

const fixtureSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.string().min(1),
  fixtureVersion: z.string().min(1),
  generatedFromPrivateData: z.literal(false),
  projects: z.array(projectSchema).min(2),
  evidence: z.array(evidenceSchema).min(1),
  cases: z.array(evaluationCaseSchema).min(1)
})

const metricThresholdsSchema = z.object({
  recallAt5: z.number().min(0).max(1),
  meanReciprocalRank: z.number().min(0).max(1),
  relevantSourceCoverage: z.number().min(0).max(1),
  wrongProjectRetrieval: z.literal(0),
  wrongProjectWriteback: z.literal(0)
})

const baselineSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.string().min(1),
  fixtureVersion: z.string().min(1),
  topK: z.literal(5),
  minimum: metricThresholdsSchema,
  frozen: metricThresholdsSchema
})

export type ContinuityFixture = z.infer<typeof fixtureSchema>
export type ContinuityBaseline = z.infer<typeof baselineSchema>

export interface ContinuityMetrics {
  readonly recallAt5: number
  readonly meanReciprocalRank: number
  readonly relevantSourceCoverage: number
  readonly wrongProjectRetrieval: number
  readonly wrongProjectWriteback: number
}

export interface EvaluationFailure {
  readonly category:
    | 'fixture_integrity'
    | 'project_resolution'
    | 'retrieval_recall'
    | 'retrieval_rank'
    | 'routing'
    | 'source_coverage'
    | 'wrong_project_retrieval'
    | 'wrong_project_writeback'
  readonly caseId: string
  readonly detail: string
}

export interface ContinuityEvaluationReport {
  readonly contractVersion: 1
  readonly suite: string
  readonly fixtureVersion: string
  readonly topK: 5
  readonly cases: number
  readonly metrics: ContinuityMetrics
  readonly minimum: ContinuityMetrics
  readonly frozen: ContinuityMetrics
  readonly failures: readonly EvaluationFailure[]
  readonly passed: boolean
  readonly deterministic: true
  readonly boronLlmCalls: 0
}

export async function loadContinuityFixture(path: string): Promise<ContinuityFixture> {
  return fixtureSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export async function loadContinuityBaseline(path: string): Promise<ContinuityBaseline> {
  return baselineSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export async function runContinuityEvaluation(
  fixture: ContinuityFixture,
  baseline: ContinuityBaseline
): Promise<ContinuityEvaluationReport> {
  if (fixture.suite !== baseline.suite || fixture.fixtureVersion !== baseline.fixtureVersion) {
    throw new Error('Fixture and frozen baseline identify different evaluation suites')
  }
  const projects = new Map(fixture.projects.map((project) => [project.id, project]))
  const evidence = new Map(fixture.evidence.map((item) => [item.id, item]))
  const failures: EvaluationFailure[] = []
  let recallTotal = 0
  let reciprocalRankTotal = 0
  let relevantEvidenceTotal = 0
  let coveredRelevantEvidence = 0
  let wrongProjectRetrieval = 0
  let wrongProjectWriteback = 0

  validateFixtureReferences(fixture, projects, evidence, failures)

  for (const evaluationCase of fixture.cases) {
    const resolver = new ContextResolver({
      projects: {
        resolve: async (request) => resolveFixtureProject(fixture, request.projectHint)
      },
      adapters: fixtureAdapters(fixture.evidence),
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      meterNow: () => 0
    })
    const resolution = await resolver.resolveWithAudit(
      evaluationCase.request,
      deterministicTraceId(evaluationCase.id)
    )
    const topFive = resolution.capsule.evidence.slice(0, 5)
    const topFiveIds = topFive.map((item) => item.id)
    const relevantIds = new Set(evaluationCase.relevantEvidenceIds)
    const relevantHits = topFive.filter((item) => relevantIds.has(item.id))
    recallTotal += relevantHits.length / evaluationCase.relevantEvidenceIds.length
    relevantEvidenceTotal += evaluationCase.relevantEvidenceIds.length
    coveredRelevantEvidence += relevantHits.filter(hasSourceEstimate).length
    const firstRelevantRank = topFive.findIndex((item) => relevantIds.has(item.id)) + 1
    reciprocalRankTotal += firstRelevantRank > 0 ? 1 / firstRelevantRank : 0

    if (resolution.capsule.project?.id !== evaluationCase.expectedProjectId) {
      failures.push({
        category: 'project_resolution',
        caseId: evaluationCase.id,
        detail: `expected ${evaluationCase.expectedProjectId}; received ${resolution.capsule.project?.id ?? 'null'}`
      })
    }
    const actualStageIds = resolution.capsule.retrievalPlan.stages.map((stage) => stage.id)
    if (JSON.stringify(actualStageIds) !== JSON.stringify(evaluationCase.expectedStageIds)) {
      failures.push({
        category: 'routing',
        caseId: evaluationCase.id,
        detail: `expected ${evaluationCase.expectedStageIds.join(',')}; received ${actualStageIds.join(',')}`
      })
    }
    for (const forbiddenId of evaluationCase.forbiddenEvidenceIds) {
      if (!topFiveIds.includes(forbiddenId)) continue
      wrongProjectRetrieval += 1
      failures.push({
        category: 'wrong_project_retrieval',
        caseId: evaluationCase.id,
        detail: `forbidden evidence ${forbiddenId} entered the top 5`
      })
    }
    if (evaluationCase.writebackScope) {
      wrongProjectWriteback += evaluateWritebackScope(
        evaluationCase.id,
        evaluationCase.writebackScope,
        projects,
        failures
      )
    }
  }

  const metrics: ContinuityMetrics = {
    recallAt5: round(recallTotal / fixture.cases.length),
    meanReciprocalRank: round(reciprocalRankTotal / fixture.cases.length),
    relevantSourceCoverage: round(
      relevantEvidenceTotal > 0 ? coveredRelevantEvidence / relevantEvidenceTotal : 0
    ),
    wrongProjectRetrieval,
    wrongProjectWriteback
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
    boronLlmCalls: 0
  }
}

function fixtureAdapters(evidence: readonly Evidence[]): ContextAdapter[] {
  return (['ontology', 'codebase', 'wiki'] as const).map((layer) => ({
    layer,
    name: `held-out-${layer}`,
    sourceType: layer === 'ontology' ? 'ontology' : 'snapshot',
    health: async () => ({ ok: true }),
    search: async (input) =>
      evidence
        .filter((item) => item.layer === layer)
        .filter(
          (item) =>
            input.purpose !== 'policy' ||
            (Array.isArray(item.metadata.evalPurposes) &&
              item.metadata.evalPurposes.includes('policy'))
        )
        .slice(0, input.limit)
  }))
}

function resolveFixtureProject(
  fixture: ContinuityFixture,
  hint: string | undefined
): ResolvedProject | null {
  if (!hint) return null
  const normalized = hint.trim().toLowerCase()
  const match = fixture.projects.find(
    (project) =>
      project.name.toLowerCase() === normalized ||
      project.aliases.some((alias) => alias.toLowerCase() === normalized)
  )
  return match ? { id: match.id, name: match.name, confidence: 1 } : null
}

function evaluateWritebackScope(
  caseId: string,
  scope: z.infer<typeof writebackScopeSchema>,
  projects: ReadonlyMap<string, z.infer<typeof projectSchema>>,
  failures: EvaluationFailure[]
): number {
  const resolved = scope.resolvedProjectId ? (projects.get(scope.resolvedProjectId) ?? null) : null
  let actual: z.infer<typeof writebackScopeSchema>['expected'] = 'accepted'
  try {
    verifyResolvedActivityProjectScope(
      scope.sessionProjectId,
      scope.projectHint,
      resolved ? { id: resolved.id, name: resolved.name, confidence: 1 } : null
    )
  } catch (error) {
    actual = error instanceof ProjectScopeError ? error.reason : 'project_unresolved'
  }
  if (actual === scope.expected) return 0
  failures.push({
    category: 'wrong_project_writeback',
    caseId,
    detail: `expected ${scope.expected}; received ${actual}`
  })
  return 1
}

function validateFixtureReferences(
  fixture: ContinuityFixture,
  projects: ReadonlyMap<string, z.infer<typeof projectSchema>>,
  evidence: ReadonlyMap<string, Evidence>,
  failures: EvaluationFailure[]
): void {
  for (const evaluationCase of fixture.cases) {
    if (!projects.has(evaluationCase.expectedProjectId)) {
      failures.push({
        category: 'fixture_integrity',
        caseId: evaluationCase.id,
        detail: `unknown expected project ${evaluationCase.expectedProjectId}`
      })
    }
    for (const evidenceId of [
      ...evaluationCase.relevantEvidenceIds,
      ...evaluationCase.forbiddenEvidenceIds
    ]) {
      if (evidence.has(evidenceId)) continue
      failures.push({
        category: 'fixture_integrity',
        caseId: evaluationCase.id,
        detail: `unknown evidence ${evidenceId}`
      })
    }
  }
}

function applyMetricGates(
  metrics: ContinuityMetrics,
  threshold: ContinuityMetrics,
  label: string,
  failures: EvaluationFailure[]
): void {
  const minimumMetrics = [
    ['recallAt5', 'retrieval_recall'],
    ['meanReciprocalRank', 'retrieval_rank'],
    ['relevantSourceCoverage', 'source_coverage']
  ] as const
  for (const [metric, category] of minimumMetrics) {
    if (metrics[metric] >= threshold[metric]) continue
    failures.push({
      category,
      caseId: 'suite',
      detail: `${metric} ${metrics[metric]} is below ${label} ${threshold[metric]}`
    })
  }
  for (const metric of ['wrongProjectRetrieval', 'wrongProjectWriteback'] as const) {
    if (metrics[metric] <= threshold[metric]) continue
    failures.push({
      category:
        metric === 'wrongProjectRetrieval' ? 'wrong_project_retrieval' : 'wrong_project_writeback',
      caseId: 'suite',
      detail: `${metric} ${metrics[metric]} exceeds ${label} ${threshold[metric]}`
    })
  }
}

function hasSourceEstimate(item: Evidence): boolean {
  const value = item.metadata.sourceTokenEstimate
  return typeof value === 'number' && Number.isFinite(value) && value > 0
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
  const fixturePath = optionValue('--fixture', 'eval/fixtures/continuity-held-out.v1.json')
  const baselinePath = optionValue('--baseline', 'eval/baselines/continuity.v1.json')
  const [fixture, baseline] = await Promise.all([
    loadContinuityFixture(fixturePath),
    loadContinuityBaseline(baselinePath)
  ])
  const report = await runContinuityEvaluation(fixture, baseline)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

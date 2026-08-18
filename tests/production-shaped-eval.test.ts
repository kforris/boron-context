import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadProductionShapedBaseline,
  loadProductionShapedFixture,
  runProductionShapedEvaluation
} from '../src/eval/production-shaped-eval.js'

describe('production-shaped continuity evaluation', () => {
  it('retrieves real repository Markdown above the frozen vision and safety gates', async () => {
    const [fixture, baseline] = await Promise.all([
      loadProductionShapedFixture(resolve('eval/fixtures/continuity-production-shaped.v1.json')),
      loadProductionShapedBaseline(resolve('eval/baselines/continuity-production-shaped.v1.json'))
    ])
    const report = await runProductionShapedEvaluation(fixture, baseline, resolve('.'))

    expect(report).toMatchObject({
      contractVersion: 1,
      cases: 18,
      passed: true,
      deterministic: true,
      generatedFromPrivateData: false,
      boronLlmCalls: 0,
      metrics: {
        recallAt5: 0.888889,
        meanReciprocalRank: 0.736111,
        relevantSourceCoverage: 0.888889,
        routingAccuracy: 1,
        riskClassificationAccuracy: 1,
        wrongProjectRetrieval: 0
      },
      failures: []
    })
  })

  it('fails the frozen gate when a repository source stops being retrievable', async () => {
    const [fixture, baseline] = await Promise.all([
      loadProductionShapedFixture(resolve('eval/fixtures/continuity-production-shaped.v1.json')),
      loadProductionShapedBaseline(resolve('eval/baselines/continuity-production-shaped.v1.json'))
    ])
    const regressed = structuredClone(fixture)
    regressed.cases[2]!.relevantPathSuffixes = ['docs/does-not-exist.md']

    const report = await runProductionShapedEvaluation(regressed, baseline, resolve('.'))

    expect(report.passed).toBe(false)
    expect(report.failures.map((failure) => failure.category)).toEqual(
      expect.arrayContaining(['retrieval_recall', 'retrieval_rank', 'source_coverage'])
    )
  })
})

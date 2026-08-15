import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadContinuityBaseline,
  loadContinuityFixture,
  runContinuityEvaluation
} from '../src/eval/continuity-eval.js'

describe('held-out continuity evaluation', () => {
  it('meets the frozen recall, rank, source, and project-scope gates', async () => {
    const [fixture, baseline] = await Promise.all([
      loadContinuityFixture(resolve('eval/fixtures/continuity-held-out.v1.json')),
      loadContinuityBaseline(resolve('eval/baselines/continuity.v1.json'))
    ])
    const report = await runContinuityEvaluation(fixture, baseline)

    expect(report).toMatchObject({
      contractVersion: 1,
      cases: 6,
      passed: true,
      deterministic: true,
      boronLlmCalls: 0,
      metrics: {
        recallAt5: 1,
        meanReciprocalRank: 1,
        relevantSourceCoverage: 1,
        wrongProjectRetrieval: 0,
        wrongProjectWriteback: 0
      },
      failures: []
    })
  })

  it('fails closed with stable categories when retrieval and writeback regress', async () => {
    const [fixture, baseline] = await Promise.all([
      loadContinuityFixture(resolve('eval/fixtures/continuity-held-out.v1.json')),
      loadContinuityBaseline(resolve('eval/baselines/continuity.v1.json'))
    ])
    const regressed = structuredClone(fixture)
    regressed.cases[0]!.relevantEvidenceIds = ['marketing-guide-decoy']
    regressed.cases[1]!.writebackScope!.expected = 'accepted'

    const report = await runContinuityEvaluation(regressed, baseline)

    expect(report.passed).toBe(false)
    expect(report.failures.map((failure) => failure.category)).toEqual(
      expect.arrayContaining(['retrieval_recall', 'source_coverage', 'wrong_project_writeback'])
    )
    expect(report.metrics.wrongProjectWriteback).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { CapsuleEvidence } from '../src/core/contracts.js'
import { classifySourceCoverage, summarizeSourceCoverage } from '../src/core/source-coverage.js'

describe('source coverage eligibility', () => {
  it('separates measured, eligible, internal, and legacy source evidence', () => {
    const fixtures = [
      item('live-measured', 'codebase', 'live', { sourceTokenEstimate: 400 }),
      item('live-missing', 'codebase', 'live'),
      item('snapshot-measured', 'wiki', 'snapshot', { sourceTokenEstimate: 300 }),
      item('snapshot-legacy', 'wiki', 'snapshot'),
      item('relation', 'ontology', 'ontology', { ontologyKind: 'relation' }),
      item('activity', 'ontology', 'ontology', { activityId: 'legacy' }, 'boron://activity/legacy'),
      item('external', 'ontology', 'ontology', {}, 'https://example.test/source'),
      item(
        'directory',
        'codebase',
        'ontology',
        { sourceSize: { status: 'not_applicable', reason: 'local_directory_reference' } },
        'file:///example/project'
      ),
      item(
        'remote',
        'wiki',
        'ontology',
        {
          activityId: 'current-contract-activity',
          sourceSize: { status: 'unavailable', reason: 'remote_source_not_fetched' }
        },
        'https://example.test/remote'
      )
    ]
    const audit = fixtures.map((fixture) => {
      const coverage = classifySourceCoverage(fixture)
      return {
        selected: true,
        sourceCoverageStatus: coverage.status,
        sourceCoverageReason: coverage.reason
      }
    })

    expect(summarizeSourceCoverage(audit, 2)).toEqual({
      contractVersion: 2,
      numerator: 2,
      eligibleDenominator: 5,
      ratio: 0.4,
      ineligible: 2,
      unobservable: 4,
      reasons: {
        eligible: {
          live_source_measured: 1,
          live_source_size_unavailable: 1,
          snapshot_source_measured: 1,
          external_source_size_unavailable: 1,
          remote_source_not_fetched: 1
        },
        ineligible: { ontology_derived: 1, local_directory_reference: 1 },
        unobservable: {
          legacy_sample_without_audit: 2,
          legacy_snapshot_unknown_size: 1,
          legacy_unknown_size: 1
        }
      }
    })
  })
})

function item(
  id: string,
  layer: CapsuleEvidence['layer'],
  sourceType: CapsuleEvidence['retrieval']['sourceType'],
  metadata: Record<string, unknown> = {},
  uri = `test://${id}`
): CapsuleEvidence {
  return {
    id,
    layer,
    title: id,
    uri,
    excerpt: id,
    confidence: 1,
    authority: 1,
    metadata,
    estimatedTokens: 1,
    score: 1,
    retrieval: { stageId: `${layer}-source`, adapter: id, sourceType }
  }
}

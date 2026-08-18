import { describe, expect, it } from 'vitest'
import type { ContextAdapter } from '../src/core/context-adapter.js'
import type { Evidence } from '../src/core/contracts.js'
import { ContextResolver, estimateTokens } from '../src/core/resolver.js'

function adapter(
  layer: 'ontology' | 'codebase' | 'wiki',
  evidence: readonly Evidence[]
): ContextAdapter {
  return {
    layer,
    name: layer,
    sourceType: layer === 'ontology' ? 'ontology' : 'snapshot',
    health: async () => ({ ok: true }),
    search: async () => evidence
  }
}

const project = { id: 'project-1', name: 'Boron Context', confidence: 1 }

describe('ContextResolver', () => {
  it('combines selected context layers into a bounded capsule', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [
        adapter('ontology', [
          {
            id: 'e1',
            layer: 'ontology',
            title: 'Project constraint',
            uri: 'boron://relation/1',
            excerpt: 'Boron Context is headless-first.',
            confidence: 1,
            authority: 1,
            projectId: project.id,
            metadata: {}
          }
        ]),
        adapter('wiki', [
          {
            id: 'e2',
            layer: 'wiki',
            title: 'Operations note',
            uri: 'wiki://operations/1',
            excerpt: 'Use launchd on macOS.',
            confidence: 0.8,
            authority: 0.8,
            projectId: project.id,
            metadata: {}
          }
        ])
      ],
      now: () => new Date('2026-07-28T00:00:00.000Z'),
      meterNow: sequence(100, 112)
    })

    const capsule = await resolver.resolve({
      objective: 'Configure Boron Context on macOS',
      projectHint: 'Boron Context',
      layers: ['ontology'],
      tokenBudget: 512,
      client: 'test'
    })

    expect(capsule.layersQueried).toEqual(['ontology'])
    expect(capsule.project).toEqual(project)
    expect(capsule.evidence).toHaveLength(1)
    expect(capsule.estimatedTokens).toBeLessThanOrEqual(512)
    expect(capsule.meter).toMatchObject({
      version: 2,
      basis: 'deterministic_estimate',
      candidateEvidenceCount: 1,
      selectedEvidenceCount: 1,
      retrievalLatencyMs: 12,
      boronLlm: { provider: 'none', model: 'none', calls: 0 }
    })
    expect(capsule.retrievalPlan.strategy).toBe('ontology_first')
    expect(capsule.meter.capsuleTokens).toBe(estimateTokens(JSON.stringify(capsule)))
  })

  it('deduplicates evidence and keeps the strongest version', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', [evidence('low', 0.3), evidence('high', 0.95)])]
    })

    const capsule = await resolver.resolve({
      objective: 'Inspect context',
      projectHint: 'Boron Context'
    })

    expect(capsule.evidence).toHaveLength(1)
    expect(capsule.evidence[0]?.id).toBe('high')
  })

  it('excludes evidence explicitly scoped to a different resolved project', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [
        adapter('ontology', [
          evidence('same-project', 0.8),
          { ...evidence('wrong-project', 1), projectId: 'project-2', uri: 'boron://wrong/1' },
          { ...evidence('unscoped', 0.7), projectId: undefined, uri: 'boron://shared/1' }
        ])
      ]
    })

    const capsule = await resolver.resolve({
      objective: 'Inspect context',
      projectHint: 'Boron Context'
    })

    expect(capsule.evidence.map((item) => item.id)).toEqual(['same-project', 'unscoped'])
  })

  it('reports an unresolved project instead of silently binding one', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => null },
      adapters: []
    })

    const capsule = await resolver.resolve({
      objective: 'Do the work',
      projectHint: 'Ambiguous project'
    })

    expect(capsule.project).toBeNull()
    expect(capsule.unresolved.some((item) => item.includes('Ambiguous project'))).toBe(true)
  })

  it('executes ontology before deterministically routed codebase retrieval', async () => {
    const calls: string[] = []
    const trackingAdapter = (layer: 'ontology' | 'codebase' | 'wiki'): ContextAdapter => ({
      layer,
      name: layer,
      sourceType: layer === 'ontology' ? 'ontology' : 'snapshot',
      health: async () => ({ ok: true }),
      search: async () => {
        calls.push(layer)
        return []
      }
    })
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [trackingAdapter('wiki'), trackingAdapter('codebase'), trackingAdapter('ontology')]
    })

    const capsule = await resolver.resolve({
      objective: 'Implement src/core/resolver.ts and run tests',
      projectHint: 'Boron Context'
    })

    expect(calls).toEqual(['ontology', 'codebase'])
    expect(capsule.retrievalPlan.stages.map((stage) => stage.id)).toEqual([
      'ontology-locate',
      'codebase-source'
    ])
    expect(capsule.layersQueried).toEqual(['ontology', 'codebase'])
  })

  it.each(['What is the project vision and roadmap?', '项目的目标、愿景和路线图是什么？'])(
    'routes project strategy questions to live knowledge: %s',
    async (objective) => {
      const calls: string[] = []
      const resolver = new ContextResolver({
        projects: { resolve: async () => project },
        adapters: [
          adapter('ontology', []),
          {
            ...adapter('wiki', []),
            name: 'Project Markdown',
            sourceType: 'live',
            search: async () => {
              calls.push('wiki')
              return []
            }
          }
        ]
      })

      const capsule = await resolver.resolve({ objective, projectHint: 'Boron Context' })

      expect(calls).toEqual(['wiki'])
      expect(capsule.retrievalPlan.stages.map((stage) => stage.id)).toEqual([
        'ontology-locate',
        'wiki-knowledge'
      ])
    }
  )

  it('routes an exact Markdown file anchor to knowledge rather than code', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', []), adapter('codebase', []), adapter('wiki', [])]
    })

    const capsule = await resolver.resolve({
      objective: 'Inspect the selected source',
      projectHint: 'Boron Context',
      objectHints: ['/workspace/docs/architecture/product-roadmap.md']
    })

    expect(capsule.retrievalPlan.stages.map((stage) => stage.id)).toEqual([
      'ontology-locate',
      'wiki-knowledge'
    ])
  })

  it('puts confirmed-policy lookup before high-risk source expansion', async () => {
    const calls: string[] = []
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [
        {
          ...adapter('ontology', []),
          search: async (input) => {
            calls.push(input.stageId)
            return input.purpose === 'policy'
              ? [
                  {
                    id: 'policy-1',
                    layer: 'ontology',
                    title: 'Release policy',
                    uri: 'boron://policy/release',
                    excerpt: 'Require explicit approval.',
                    confidence: 1,
                    authority: 1,
                    projectId: project.id,
                    metadata: { ontologyKind: 'policy' }
                  }
                ]
              : []
          }
        },
        {
          ...adapter('codebase', []),
          search: async (input) => {
            calls.push(input.stageId)
            return []
          }
        }
      ]
    })

    const capsule = await resolver.resolve({
      objective: 'Deploy and publish the TypeScript release',
      projectHint: 'Boron Context'
    })

    expect(calls).toEqual(['ontology-locate', 'ontology-policy', 'codebase-source'])
    expect(capsule.retrievalPlan.riskClass).toBe('high')
    expect(capsule.unresolved).not.toContain(
      'High-risk intent detected, but no matching confirmed policy evidence was found.'
    )
  })

  it.each([
    'Assess release readiness and do not publish or submit to Marketplace.',
    '只读检查发布准备度，不执行发布、推送或任何变更。'
  ])(
    'does not route explicitly read-only release assessment through policy: %s',
    async (objective) => {
      const resolver = new ContextResolver({
        projects: { resolve: async () => project },
        adapters: [adapter('ontology', [])]
      })

      const capsule = await resolver.resolve({
        objective,
        projectHint: 'Boron Context',
        constraints: ['read-only', 'no mutation'],
        layers: ['ontology'],
        workflow: 'read'
      })

      expect(capsule.retrievalPlan.riskClass).toBe('standard')
      expect(capsule.retrievalPlan.stages.map((stage) => stage.id)).toEqual(['ontology-locate'])
      expect(capsule.unresolved).not.toContain(
        'High-risk intent detected, but no matching confirmed policy evidence was found.'
      )
    }
  )

  it('keeps a real release or deployment action high risk despite adjacent read-only language', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', [])]
    })

    const capsule = await resolver.resolve({
      objective: 'Review the release notes and then deploy and publish the release.',
      projectHint: 'Boron Context',
      layers: ['ontology'],
      workflow: 'read'
    })

    expect(capsule.retrievalPlan.riskClass).toBe('high')
    expect(capsule.retrievalPlan.stages.map((stage) => stage.id)).toEqual([
      'ontology-locate',
      'ontology-policy'
    ])
  })

  it('queries every live adapter in a layer and skips the snapshot when one succeeds', async () => {
    const calls: string[] = []
    const live = (name: string, id: string): ContextAdapter => ({
      ...adapter('wiki', [{ ...evidence(id, 1), layer: 'wiki', uri: `file:///project/${id}.md` }]),
      name,
      sourceType: 'live',
      search: async () => {
        calls.push(name)
        return [{ ...evidence(id, 1), layer: 'wiki', uri: `file:///project/${id}.md` }]
      }
    })
    const snapshot: ContextAdapter = {
      ...adapter('wiki', []),
      name: 'snapshot',
      sourceType: 'snapshot',
      search: async () => {
        calls.push('snapshot')
        return []
      }
    }
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [
        adapter('ontology', []),
        live('OpenWiki', 'openwiki'),
        live('Project Markdown', 'project-doc'),
        snapshot
      ]
    })

    const capsule = await resolver.resolve({
      objective: 'Read project documentation',
      projectHint: 'Boron Context',
      layers: ['ontology', 'wiki']
    })

    expect(calls).toEqual(['OpenWiki', 'Project Markdown'])
    expect(capsule.evidence.map((item) => item.id).sort()).toEqual(['openwiki', 'project-doc'])
    expect(capsule.retrievalPlan.stages[1]?.adapters).toEqual([
      { name: 'OpenWiki', sourceType: 'live', status: 'succeeded' },
      { name: 'Project Markdown', sourceType: 'live', status: 'succeeded' }
    ])
  })

  it('keeps source-window savings unavailable without recorded source coverage', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', [evidence('activity', 1)])]
    })

    const resolution = await resolver.resolveWithAudit({
      objective: 'Continue the previous work',
      projectHint: 'Boron Context',
      layers: ['ontology']
    })

    expect(resolution.capsule.meter).toMatchObject({
      reExplanationAvoidedTokens: expect.any(Number),
      sourceWindowStatus: 'not_covered',
      sourceWindowOriginalTokens: null,
      sourceWindowSavingsTokens: null,
      sourceWindowSavingsRatio: null
    })
    expect(resolution.evidenceAudit[0]).toMatchObject({
      selected: true,
      sourceTokenEstimate: null,
      adapter: 'ontology'
    })
  })

  it('measures only evidence with a real sourceTokenEstimate', async () => {
    const covered = {
      ...evidence('covered', 1),
      metadata: { activityId: 'verified-activity', sourceTokenEstimate: 1_000 }
    }
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', [covered])]
    })

    const capsule = await resolver.resolve({
      objective: 'Inspect context',
      projectHint: 'Boron Context'
    })

    expect(capsule.meter.sourceWindowStatus).toBe('measured_full')
    expect(capsule.meter.sourceWindowOriginalTokens).toBe(1_000)
    expect(capsule.meter.sourceWindowSavingsTokens).toBeGreaterThan(0)
    expect(capsule.meter.sourceWindowCoverageRatio).toBe(1)
  })

  it('labels a PostgreSQL snapshot as fallback when the live source fails', async () => {
    const live: ContextAdapter = {
      ...adapter('codebase', []),
      name: 'Live Codebase Memory',
      sourceType: 'live',
      search: async () => {
        throw new Error('unavailable')
      }
    }
    const snapshot: ContextAdapter = {
      ...adapter('codebase', [
        {
          ...evidence('snapshot', 1),
          layer: 'codebase',
          uri: 'file:///project/src/resolver.ts'
        }
      ]),
      name: 'PostgreSQL codebase snapshot',
      sourceType: 'snapshot'
    }
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', []), live, snapshot]
    })

    const capsule = await resolver.resolve({
      objective: 'Inspect the resolver TypeScript code',
      projectHint: 'Boron Context'
    })

    const stage = capsule.retrievalPlan.stages.find((item) => item.id === 'codebase-source')
    expect(stage?.adapters).toEqual([
      {
        name: 'Live Codebase Memory',
        sourceType: 'live',
        status: 'failed',
        detail: 'search failed'
      },
      {
        name: 'PostgreSQL codebase snapshot',
        sourceType: 'snapshot',
        status: 'fallback'
      }
    ])
    expect(capsule.evidence[0]?.retrieval.sourceType).toBe('snapshot')
  })
})

function evidence(id: string, confidence: number): Evidence {
  return {
    id,
    layer: 'ontology',
    title: 'Same evidence',
    uri: 'boron://evidence/same',
    excerpt: 'Inspect context',
    confidence,
    authority: confidence,
    contentHash: 'same',
    projectId: project.id,
    metadata: { activityId: id }
  }
}

describe('estimateTokens', () => {
  it('uses a deterministic conservative character estimate', () => {
    expect(estimateTokens('12345678')).toBe(2)
    expect(estimateTokens('')).toBe(1)
  })
})

function sequence(...values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

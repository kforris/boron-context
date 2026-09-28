import { describe, expect, it } from 'vitest'
import type { ContextAdapter } from '../src/core/context-adapter.js'
import type { Evidence } from '../src/core/contracts.js'
import { buildRetrievalPlan, ContextResolver, estimateTokens } from '../src/core/resolver.js'

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
const strategyObjective =
  '核对已确定的最终愿景与设计边界：让每次任务更懂项目；跨任务/跨Agent的持久项目理解，Ontology事实/关系、Codebase和Wiki分工，最小有来源上下文，语义变化回写和过时状态失效，Sample与Portfolio执行层的边界。查找对应用户决策和设计依据，用于下一阶段改进建议。'

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

  it('routes a Chinese strategic handoff to knowledge without inventing paths or action intent', () => {
    const plan = buildRetrievalPlan({
      objective: strategyObjective,
      projectHint: 'Sample',
      workflow: 'session_start'
    })

    expect(plan.riskClass).toBe('standard')
    expect(plan.sourceAnchors).toEqual([])
    expect(plan.signals).toContain('strategy')
    expect(plan.stages.map((stage) => stage.id)).toEqual(['ontology-locate', 'wiki-knowledge'])
  })

  it.each([
    ['跨任务/跨Agent，B2B/B2C；Ontology事实/关系', []],
    [
      'Inspect src/core/resolver.ts and docs/product-roadmap.md.',
      ['src/core/resolver.ts', 'docs/product-roadmap.md']
    ],
    ['Read `/workspace/资料/设计.md`。', ['/workspace/资料/设计.md']],
    [
      'Read https://example.test/docs/vision and file:///workspace/README.md.',
      ['https://example.test/docs/vision', 'file:///workspace/README.md']
    ],
    [
      'Inspect ./src and ../docs, then ContextResolver.resolve().',
      ['./src', '../docs', 'ContextResolver.resolve()']
    ]
  ])('distinguishes source anchors from slash-separated prose: %s', (objective, anchors) => {
    const plan = buildRetrievalPlan({ objective, objectHints: ['跨任务/跨Agent'] })
    expect(plan.sourceAnchors).toEqual(anchors)
  })

  it.each([
    strategyObjective,
    'What is the Sample vision and design rationale for durable project understanding?'
  ])(
    'ranks design knowledge above repeated authoritative audits for strategy: %s',
    async (objective) => {
      const localProject = { ...project, name: 'Sample' }
      const audits: Evidence[] = Array.from({ length: 8 }, (_, index) => ({
        id: `audit-${index}`,
        layer: 'ontology',
        title: 'Activity: release_candidate.audit_completed',
        uri: `boron://activity/audit-${index}`,
        excerpt:
          'Sample RC audit: exact-main CI, adapters, TLS, rolling adoption, source coverage and latency passed. Release remains NO-GO.',
        confidence: 1,
        authority: 1,
        projectId: project.id,
        metadata: { activityId: `audit-${index}`, adapterRelevance: 1 }
      }))
      const design: Evidence = {
        id: 'design',
        layer: 'wiki',
        title: 'Sample vision and system design',
        uri: 'file:///workspace/docs/system-design.md',
        excerpt:
          'The vision is durable project understanding across sessions and agents. Architecture separates verified facts, source code, and narrative knowledge; preserve decisions with evidence and supersede obsolete state.',
        confidence: 0.9,
        authority: 0.9,
        projectId: project.id,
        metadata: { adapterRelevance: 0.1, sourceTokenEstimate: 2000 }
      }
      const resolver = new ContextResolver({
        projects: { resolve: async () => localProject },
        adapters: [adapter('ontology', audits), adapter('wiki', [design])]
      })

      const resolution = await resolver.resolveWithAudit({
        objective,
        projectHint: 'Sample',
        tokenBudget: 1100
      })

      expect(resolution.capsule.evidence[0]?.id).toBe('design')
      expect(resolution.evidenceAudit).toHaveLength(9)
      expect(
        resolution.evidenceAudit.filter((item) => item.evidenceId.startsWith('audit-'))
      ).toHaveLength(8)
      expect(resolution.capsule.meter.boronLlm.calls).toBe(0)
    }
  )

  it('keeps audit evidence relevant for an explicit strategic readiness audit', async () => {
    const audit: Evidence = {
      ...evidence('audit', 1),
      title: 'Activity: release_candidate.audit_completed',
      uri: 'boron://activity/audit',
      excerpt:
        'The roadmap readiness audit found passing CI and healthy adapters; remaining release blockers are parity and latency.'
    }
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', [audit]), adapter('wiki', [])]
    })
    const capsule = await resolver.resolve({
      objective: 'Audit the roadmap readiness and remaining release blockers.'
    })
    expect(capsule.evidence[0]?.id).toBe('audit')
    expect(capsule.evidence[0]?.score).toBeGreaterThan(0.7)
  })

  it('does not demote an audit explicitly referenced as evidence for the vision', async () => {
    const audit: Evidence = {
      ...evidence('audit', 1),
      title: 'Activity: release_candidate.audit_completed',
      uri: 'boron://activity/audit',
      excerpt: 'Source readback of the previous design decision.'
    }
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', [audit]), adapter('wiki', [])]
    })
    const capsule = await resolver.resolve({
      objective: '查找愿景的依据',
      objectHints: ['boron://activity/audit']
    })
    expect(capsule.retrievalPlan.sourceAnchors).toEqual(['boron://activity/audit'])
    expect(capsule.evidence[0]?.score).toBeGreaterThan(0.7)
  })

  it.each([
    '核对愿景，然后部署执行层更新并授权生产权限。',
    'Review the project vision, then grant deployment permissions and publish the release.',
    '执行层部署更新。'
  ])(
    'retains the policy stage for genuine actions alongside strategic language: %s',
    (objective) => {
      const plan = buildRetrievalPlan({ objective, workflow: 'read' })
      expect(plan.riskClass).toBe('high')
      expect(plan.stages[1]?.id).toBe('ontology-policy')
    }
  )

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
    'What is the Boron Context roadmap and remaining macOS release-candidate lifecycle work?',
    'Review the release checklist and readiness gates.',
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

  it('treats a release-checklist path hint as nominal read-only context', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => project },
      adapters: [adapter('ontology', [])]
    })

    const capsule = await resolver.resolve({
      objective:
        'Inspect the release-candidate checklist without publishing or submitting anything.',
      projectHint: 'Boron Context',
      objectHints: ['docs/release-checklist.md'],
      constraints: ['read-only', 'no mutation'],
      layers: ['ontology'],
      workflow: 'read'
    })

    expect(capsule.retrievalPlan.riskClass).toBe('standard')
    expect(capsule.retrievalPlan.stages.map((stage) => stage.id)).toEqual(['ontology-locate'])
    expect(capsule.unresolved).not.toContain(
      'High-risk intent detected, but no matching confirmed policy evidence was found.'
    )
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

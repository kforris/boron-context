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
      now: () => new Date('2026-07-28T00:00:00.000Z')
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
    expect(capsule.unresolved[0]).toContain('Ambiguous project')
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
    metadata: {}
  }
}

describe('estimateTokens', () => {
  it('uses a deterministic conservative character estimate', () => {
    expect(estimateTokens('12345678')).toBe(2)
    expect(estimateTokens('')).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import {
  projectArchitectureGraph,
  projectCallNeighborhood
} from '../src/inspector/codebase-spatial.js'

describe('spatial codebase projection', () => {
  it('creates a bounded deterministic graph without source contents or paths', () => {
    const clusters = Array.from({ length: 24 }, (_, index) => ({
      id: index,
      label: `cluster-${index}`,
      members: 100 - index,
      cohesion: 0.8,
      top_nodes: Array.from(
        { length: 9 },
        (__, symbol) => `project.package.cluster${index}.symbol${symbol}`
      ),
      packages: ['src']
    }))
    const result = projectArchitectureGraph('Users-test-Boron-Context', {
      project: 'Users-test-Boron-Context',
      total_nodes: 5_000,
      total_edges: 12_000,
      clusters
    })

    expect(result).toMatchObject({
      sourceType: 'live',
      projection: 'architecture_clusters_lod_v2',
      original: { nodes: 5_000, edges: 12_000 }
    })
    expect(result.nodes.filter((node) => node.kind === 'code_root')).toHaveLength(1)
    expect(result.nodes.filter((node) => node.kind === 'code_cluster')).toHaveLength(18)
    expect(result.edges).toHaveLength(18 + 18 * 6)
    expect(result.nodes.every((node) => node.confirmationState === 'derived')).toBe(true)
    expect(result.nodes.some((node) => node.name === 'symbol0')).toBe(true)
    expect(result.nodes.some((node) => node.lod === 0)).toBe(true)
    expect(result.nodes.some((node) => node.lod === 1)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('/Users/')
    expect(JSON.stringify(result)).not.toContain('file_path')
    expect(JSON.stringify(result)).not.toContain('sourceText')
  })

  it('bounds and deterministically projects a one-hop call neighborhood', () => {
    const callers = Array.from({ length: 18 }, (_, index) => ({
      name: `caller${index}`,
      qualified_name: `project.module.caller${String(index).padStart(2, '0')}`,
      hop: 1
    }))
    const callees = Array.from({ length: 17 }, (_, index) => ({
      name: `callee${index}`,
      qualified_name: `project.module.callee${String(index).padStart(2, '0')}`,
      hop: 1
    }))
    const result = projectCallNeighborhood('Users-test-Boron-Context', 'routeRequest', {
      function: 'routeRequest',
      direction: 'both',
      mode: 'calls',
      callers,
      callees
    })

    expect(result).toMatchObject({
      sourceType: 'live',
      projection: 'call_neighborhood_lod_v1',
      focusLookupKey: 'routeRequest',
      truncated: true
    })
    expect(result.nodes).toHaveLength(25)
    expect(result.edges).toHaveLength(24)
    expect(result.nodes.every((node) => node.lod === 2)).toBe(true)
    expect(result.edges.every((edge) => edge.relationType === 'CALLS')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('/Users/')
    expect(JSON.stringify(result)).not.toContain('file_path')
  })
})

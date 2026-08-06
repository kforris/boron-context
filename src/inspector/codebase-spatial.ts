import { z } from 'zod'

const clusterSchema = z.object({
  id: z.union([z.string(), z.number()]),
  label: z.string(),
  members: z.number().int().nonnegative(),
  cohesion: z.number().nonnegative(),
  top_nodes: z.array(z.string()),
  packages: z.array(z.string()).default([])
})

const architectureSchema = z.object({
  project: z.string().optional(),
  total_nodes: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
  clusters: z.array(clusterSchema).default([])
})

const traceNodeSchema = z.object({
  name: z.string(),
  qualified_name: z.string(),
  hop: z.number().int().positive()
})

const traceSchema = z.object({
  function: z.string(),
  direction: z.string().optional(),
  mode: z.string().optional(),
  callees: z.array(traceNodeSchema).default([]),
  callers: z.array(traceNodeSchema).default([])
})

const rpcEnvelopeSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
  result: z
    .object({
      content: z.array(z.object({ text: z.string().optional() })).optional()
    })
    .optional()
})

export interface SpatialGraphNode {
  readonly id: string
  readonly name: string
  readonly kind: 'code_root' | 'code_cluster' | 'code_symbol'
  readonly confirmationState: 'derived'
  readonly weight: number
  readonly lod: 0 | 1 | 2
  readonly parentId?: string
  readonly lookupKey?: string
  readonly detail?: string
}

export interface SpatialGraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly relationType: 'SURFACES_CLUSTER' | 'SURFACES_TOP_NODE' | 'CALLS'
  readonly confirmationState: 'derived'
}

export interface SpatialCodebaseGraph {
  readonly project: string
  readonly sourceType: 'live'
  readonly projection: 'architecture_clusters_lod_v2'
  readonly original: {
    readonly nodes: number
    readonly edges: number
  }
  readonly nodes: readonly SpatialGraphNode[]
  readonly edges: readonly SpatialGraphEdge[]
}

export interface SpatialCodebaseNeighborhood {
  readonly project: string
  readonly sourceType: 'live'
  readonly projection: 'call_neighborhood_lod_v1'
  readonly focusId: string
  readonly focusLookupKey: string
  readonly nodes: readonly SpatialGraphNode[]
  readonly edges: readonly SpatialGraphEdge[]
  readonly truncated: boolean
}

export async function loadSpatialCodebaseGraph(
  baseUrl: string,
  project: string,
  request: typeof fetch = fetch
): Promise<SpatialCodebaseGraph> {
  const architecture = await callCodebaseMemory(
    baseUrl,
    'get_architecture',
    { project, aspects: ['clusters'] },
    request
  )
  return projectArchitectureGraph(project, architectureSchema.parse(architecture))
}

export async function loadSpatialCodebaseNeighborhood(
  baseUrl: string,
  project: string,
  symbol: string,
  request: typeof fetch = fetch
): Promise<SpatialCodebaseNeighborhood> {
  const trace = traceSchema.parse(
    await callCodebaseMemory(
      baseUrl,
      'trace_path',
      {
        project,
        function_name: symbol,
        direction: 'both',
        depth: 1,
        mode: 'calls',
        include_tests: false,
        risk_labels: false
      },
      request
    )
  )
  return projectCallNeighborhood(project, symbol, trace)
}

export function projectArchitectureGraph(
  project: string,
  architecture: z.infer<typeof architectureSchema>
): SpatialCodebaseGraph {
  const nodes = new Map<string, SpatialGraphNode>()
  const edges: SpatialGraphEdge[] = []
  const rootId = codeRootId(project)
  nodes.set(rootId, {
    id: rootId,
    name: compactProjectName(project),
    kind: 'code_root',
    confirmationState: 'derived',
    weight: Math.max(1, architecture.total_nodes),
    lod: 0,
    detail: `${architecture.total_nodes} indexed nodes · ${architecture.total_edges} indexed edges`
  })
  // These caps are a data-minimization boundary, not only a rendering optimization. The Spatial
  // Inspector reveals representative structure first and fetches source-free call data on demand.
  const clusters = [...architecture.clusters]
    .sort(
      (left, right) =>
        right.members - left.members || String(left.id).localeCompare(String(right.id))
    )
    .slice(0, 18)

  for (const cluster of clusters) {
    const clusterId = `codebase://${encodeURIComponent(project)}/cluster/${encodeURIComponent(String(cluster.id))}`
    nodes.set(clusterId, {
      id: clusterId,
      name: clusterName(cluster.label, cluster.id, cluster.top_nodes),
      kind: 'code_cluster',
      confirmationState: 'derived',
      weight: Math.max(1, cluster.members),
      lod: 0,
      parentId: rootId,
      detail: `${cluster.members} members · ${Math.round(cluster.cohesion * 100)}% cohesion`
    })
    edges.push({
      id: `${rootId}->${clusterId}`,
      source: rootId,
      target: clusterId,
      relationType: 'SURFACES_CLUSTER',
      confirmationState: 'derived'
    })
    for (const symbolName of cluster.top_nodes.slice(0, 6)) {
      const symbolId = codeSymbolId(project, symbolName)
      if (!nodes.has(symbolId)) {
        nodes.set(symbolId, {
          id: symbolId,
          name: compactName(symbolName),
          kind: 'code_symbol',
          confirmationState: 'derived',
          weight: 1,
          lod: 1,
          parentId: clusterId,
          lookupKey: symbolName,
          detail: 'Representative symbol · pinch again for local call graph'
        })
      }
      edges.push({
        id: `${clusterId}->${symbolId}`,
        source: clusterId,
        target: symbolId,
        relationType: 'SURFACES_TOP_NODE',
        confirmationState: 'derived'
      })
    }
  }

  return {
    project,
    sourceType: 'live',
    projection: 'architecture_clusters_lod_v2',
    original: { nodes: architecture.total_nodes, edges: architecture.total_edges },
    nodes: [...nodes.values()],
    edges
  }
}

export function projectCallNeighborhood(
  project: string,
  symbol: string,
  trace: z.infer<typeof traceSchema>
): SpatialCodebaseNeighborhood {
  const focusId = codeSymbolId(project, symbol)
  const nodes = new Map<string, SpatialGraphNode>()
  const edges = new Map<string, SpatialGraphEdge>()
  nodes.set(focusId, {
    id: focusId,
    name: compactName(symbol),
    kind: 'code_symbol',
    confirmationState: 'derived',
    weight: 2,
    lod: 2,
    lookupKey: symbol,
    detail: 'Selected symbol · one-hop live call neighborhood'
  })
  const callers = boundedTraceNodes(trace.callers)
  const callees = boundedTraceNodes(trace.callees)

  for (const caller of callers) {
    const callerId = codeSymbolId(project, caller.qualified_name)
    addTraceNode(nodes, callerId, caller)
    edges.set(`${callerId}->${focusId}`, {
      id: `${callerId}->${focusId}`,
      source: callerId,
      target: focusId,
      relationType: 'CALLS',
      confirmationState: 'derived'
    })
  }
  for (const callee of callees) {
    const calleeId = codeSymbolId(project, callee.qualified_name)
    addTraceNode(nodes, calleeId, callee)
    edges.set(`${focusId}->${calleeId}`, {
      id: `${focusId}->${calleeId}`,
      source: focusId,
      target: calleeId,
      relationType: 'CALLS',
      confirmationState: 'derived'
    })
  }

  return {
    project,
    sourceType: 'live',
    projection: 'call_neighborhood_lod_v1',
    focusId,
    focusLookupKey: symbol,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: trace.callers.length > callers.length || trace.callees.length > callees.length
  }
}

async function callCodebaseMemory(
  baseUrl: string,
  tool: string,
  arguments_: Record<string, unknown>,
  request: typeof fetch
): Promise<unknown> {
  const response = await request(`${baseUrl.replace(/\/+$/, '')}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: arguments_ }
    }),
    signal: AbortSignal.timeout(5_000)
  })
  const envelope = rpcEnvelopeSchema.parse(await response.json())
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message ?? `Codebase Memory returned HTTP ${response.status}`)
  }
  const text = envelope.result?.content?.[0]?.text
  if (!text) throw new Error(`Codebase Memory returned no ${tool} result`)
  return JSON.parse(text)
}

function boundedTraceNodes(nodes: readonly z.infer<typeof traceNodeSchema>[]) {
  return [...nodes]
    .sort(
      (left, right) =>
        left.hop - right.hop || left.qualified_name.localeCompare(right.qualified_name)
    )
    .slice(0, 12)
}

function addTraceNode(
  nodes: Map<string, SpatialGraphNode>,
  id: string,
  node: z.infer<typeof traceNodeSchema>
): void {
  if (nodes.has(id)) return
  nodes.set(id, {
    id,
    name: compactName(node.name),
    kind: 'code_symbol',
    confirmationState: 'derived',
    weight: 1,
    lod: 2,
    lookupKey: node.qualified_name,
    detail: `One-hop ${node.hop === 1 ? 'call relation' : `distance ${node.hop}`}`
  })
}

function codeRootId(project: string): string {
  return `codebase://${encodeURIComponent(project)}/root`
}

function codeSymbolId(project: string, symbol: string): string {
  return `codebase://${encodeURIComponent(project)}/symbol/${encodeURIComponent(symbol)}`
}

function compactProjectName(value: string): string {
  return value.replace(/^Users-[^-]+-/, '').replaceAll('-', ' ')
}

function clusterName(label: string, id: string | number, topNodes: readonly string[]): string {
  const distinct = [...new Set(topNodes.map(compactName))].slice(0, 2)
  if (distinct.length) return distinct.join(' / ')
  return label && label !== 'src' ? compactName(label) : `Architecture ${id}`
}

function compactName(value: string): string {
  const parts = value.split('.')
  const compact = parts.at(-1) || value
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact
}

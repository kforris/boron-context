import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import type { AdapterSearchInput, ContextAdapter } from '../core/context-adapter.js'
import type { Evidence } from '../core/contracts.js'

interface CodebaseProject {
  readonly name: string
  readonly root_path?: string
}

interface SearchResult {
  readonly name?: string
  readonly qualified_name?: string
  readonly label?: string
  readonly file_path?: string
  readonly start_line?: number
  readonly end_line?: number
}

export class CodebaseMemoryAdapter implements ContextAdapter {
  readonly layer = 'codebase' as const
  readonly name = 'Codebase Memory live graph'
  readonly sourceType = 'live' as const

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5_000,
    private readonly request: typeof fetch = fetch
  ) {}

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      await this.rpc('list_projects', {})
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  async search(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    const projectPayload = await this.rpc('list_projects', {})
    const projects = array(projectPayload.projects) as CodebaseProject[]
    const selected = selectProject(projects, input.resolvedProjectName ?? input.request.projectHint)
    if (!selected) return []
    const payload = await this.rpc('search_graph', {
      project: selected.name,
      query: input.request.objective,
      limit: Math.min(input.limit, 24),
      include_connected: true
    })
    const results = array(payload.results) as SearchResult[]
    return Promise.all(
      results.slice(0, input.limit).map((item) => this.evidence(selected, item, input.projectId))
    )
  }

  private async evidence(
    project: CodebaseProject,
    item: SearchResult,
    projectId: string | null
  ): Promise<Evidence> {
    const qualifiedName = item.qualified_name ?? item.name ?? 'unknown'
    const file = item.file_path ?? ''
    const location = file ? `${file}${item.start_line ? `:${item.start_line}` : ''}` : qualifiedName
    const source = await sourceFile(project.root_path, file)
    const uri = `codebase-memory://${encodeURIComponent(project.name)}/${encodeURIComponent(qualifiedName)}`
    return {
      id: createHash('sha256')
        .update(`${project.name}\0${qualifiedName}\0${location}`)
        .digest('hex'),
      layer: 'codebase',
      title: `${item.label ?? 'Code entity'}: ${item.name ?? qualifiedName}`,
      uri,
      excerpt: `${qualifiedName} is a ${item.label ?? 'code entity'} at ${location}.`,
      confidence: 0.9,
      authority: 0.95,
      ...(source?.updatedAt ? { updatedAt: source.updatedAt } : {}),
      ...(projectId ? { projectId } : {}),
      metadata: {
        indexProject: project.name,
        qualifiedName,
        filePath: file,
        ...(source?.sourceTokenEstimate ? { sourceTokenEstimate: source.sourceTokenEstimate } : {})
      }
    }
  }

  private async rpc(
    name: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    const response = await this.request(`${this.baseUrl.replace(/\/+$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    const body = (await response.json()) as {
      error?: { message?: string }
      result?: { content?: readonly { text?: string }[] }
    }
    if (!response.ok || body.error) {
      throw new Error(body.error?.message ?? `Codebase Memory returned HTTP ${response.status}`)
    }
    const text = body.result?.content?.[0]?.text
    if (!text) return {}
    return JSON.parse(text) as Record<string, unknown>
  }
}

function selectProject(
  projects: readonly CodebaseProject[],
  hint: string | undefined
): CodebaseProject | null {
  if (!hint) return null
  const normalizedHint = normalize(hint)
  const exact = projects.filter((project) => normalize(project.name) === normalizedHint)
  if (exact.length === 1) return exact[0]!
  const matches = projects.filter((project) => normalize(project.name).includes(normalizedHint))
  return matches.length === 1 ? matches[0]! : null
}

async function sourceFile(
  root: string | undefined,
  file: string
): Promise<{ readonly updatedAt: string; readonly sourceTokenEstimate: number } | null> {
  if (!root || !file) return null
  const path = resolve(root, file)
  if (relative(resolve(root), path).startsWith('..')) return null
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return {
      updatedAt: info.mtime.toISOString(),
      sourceTokenEstimate: Math.max(1, Math.ceil(info.size / 4))
    }
  } catch {
    return null
  }
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '')
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

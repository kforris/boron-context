import type { AdapterSearchInput, ContextAdapter } from '../core/context-adapter.js'
import type { Evidence } from '../core/contracts.js'
import { searchMarkdownSources } from './markdown-search.js'

export type RegisteredProjectRoots = (projectId: string) => Promise<readonly string[]>

export class ProjectMarkdownAdapter implements ContextAdapter {
  readonly layer = 'wiki' as const
  readonly name = 'Registered project Markdown'
  readonly sourceType = 'live' as const

  constructor(private readonly registeredRoots: RegisteredProjectRoots) {}

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true, detail: 'Project roots are resolved from confirmed Ontology relations' }
  }

  async search(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    if (!input.projectId) return []
    const roots = await this.registeredRoots(input.projectId)
    return searchMarkdownSources(
      roots.map((root) => ({
        root,
        sourceKind: 'registered_project_root' as const,
        requireProjectIdentity: false
      })),
      input
    )
  }
}

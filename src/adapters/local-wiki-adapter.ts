import { stat } from 'node:fs/promises'
import type { AdapterSearchInput, ContextAdapter } from '../core/context-adapter.js'
import type { Evidence } from '../core/contracts.js'
import { searchMarkdownSources } from './markdown-search.js'

export class LocalWikiAdapter implements ContextAdapter {
  readonly layer = 'wiki' as const
  readonly name = 'OpenWiki live Markdown'
  readonly sourceType = 'live' as const

  constructor(private readonly root: string) {}

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      const info = await stat(this.root)
      return info.isDirectory()
        ? { ok: true }
        : { ok: false, detail: 'OpenWiki root is not a directory' }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    return searchMarkdownSources(
      [{ root: this.root, sourceKind: 'openwiki', requireProjectIdentity: true }],
      input
    )
  }
}

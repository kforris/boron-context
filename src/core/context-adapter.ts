import type { ContextLayer, Evidence, ResolveContextRequest } from './contracts.js'

export interface AdapterSearchInput {
  readonly request: ResolveContextRequest
  readonly projectId: string | null
  readonly limit: number
}

export interface ContextAdapter {
  readonly layer: ContextLayer
  readonly name: string
  health(): Promise<{ readonly ok: boolean; readonly detail?: string }>
  search(input: AdapterSearchInput): Promise<readonly Evidence[]>
}

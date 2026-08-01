import type {
  AdapterSourceType,
  ContextLayer,
  Evidence,
  ResolveContextRequest,
  RetrievalPurpose
} from './contracts.js'

export interface AdapterSearchInput {
  readonly request: ResolveContextRequest
  readonly projectId: string | null
  readonly limit: number
  readonly stageId: string
  readonly purpose: RetrievalPurpose
  readonly sourceAnchors: readonly string[]
}

export interface ContextAdapter {
  readonly layer: ContextLayer
  readonly name: string
  readonly sourceType: AdapterSourceType
  health(): Promise<{ readonly ok: boolean; readonly detail?: string }>
  search(input: AdapterSearchInput): Promise<readonly Evidence[]>
}

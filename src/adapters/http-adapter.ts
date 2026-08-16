import type { ContextAdapter, AdapterSearchInput } from '../core/context-adapter.js'
import {
  contextLayerSchema,
  evidenceSchema,
  type ContextLayer,
  type Evidence
} from '../core/contracts.js'

export interface HttpContextAdapterOptions {
  readonly layer: ContextLayer
  readonly name: string
  readonly baseUrl: string
  readonly token?: string
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

export class HttpContextAdapter implements ContextAdapter {
  readonly layer: ContextLayer
  readonly name: string
  readonly sourceType = 'live' as const
  private readonly baseUrl: URL
  private readonly token: string | undefined
  private readonly timeoutMs: number
  private readonly request: typeof fetch

  constructor(options: HttpContextAdapterOptions) {
    this.layer = contextLayerSchema.parse(options.layer)
    this.name = options.name
    this.baseUrl = new URL(options.baseUrl)
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.request = options.fetch ?? fetch
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      const response = await this.request(new URL('/health', this.baseUrl), {
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      return response.ok
        ? { ok: true }
        : { ok: false, detail: `HTTP ${response.status} from ${this.name}` }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  async search(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    const response = await this.request(new URL('/v1/search', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({
        query: input.request.objective,
        projectId: input.projectId,
        objectHints: input.request.objectHints,
        limit: input.limit
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!response.ok) throw new Error(`${this.name} search failed with HTTP ${response.status}`)
    const body = (await response.json()) as unknown
    const parsed = evidenceSchema.array().parse(body)
    return parsed.map((item) => {
      const estimate = item.metadata.sourceTokenEstimate
      const measured = typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0
      return {
        ...item,
        layer: this.layer,
        metadata: {
          ...item.metadata,
          sourceSize: measured
            ? {
                status: 'measured',
                tokenEstimate: Math.round(estimate),
                basis: 'upstream_reported_token_estimate'
              }
            : { status: 'unavailable', reason: 'upstream_source_size_unavailable' }
        }
      }
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

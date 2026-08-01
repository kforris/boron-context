import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ZodError } from 'zod'
import type { ContextAdapter } from '../core/context-adapter.js'
import {
  completeSessionRequestSchema,
  contextMeterAuditRequestSchema,
  contextMeterSummaryRequestSchema,
  recordActivityRequestSchema,
  startSessionRequestSchema
} from '../core/contracts.js'
import type { ContextResolver } from '../core/resolver.js'
import type { PostgresActivityRepository } from '../db/activity-repository.js'

const MAX_BODY_BYTES = 256 * 1024

export interface GatewayOptions {
  readonly host: string
  readonly port: number
  readonly token: string
  readonly resolver: ContextResolver
  readonly activity: PostgresActivityRepository
  readonly adapters: readonly ContextAdapter[]
  readonly databaseHealth: () => Promise<{ readonly ok: boolean; readonly detail?: string }>
  readonly version: string
}

export interface RunningGateway {
  readonly server: Server
  readonly url: string
  close(): Promise<void>
}

export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  assertSafeHost(options.host)
  const server = createServer((request, response) => {
    void routeRequest(options, request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    server,
    url: `http://${options.host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

async function routeRequest(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const traceId = headerTraceId(request) ?? randomUUID()
  response.setHeader('x-boron-trace-id', traceId)
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const [database, ...adapters] = await Promise.all([
        options.databaseHealth(),
        ...options.adapters.map((adapter) => adapter.health())
      ])
      json(response, database.ok ? 200 : 503, {
        ok: database.ok,
        service: 'boron-context',
        version: options.version,
        database,
        adapters: options.adapters.map((adapter, index) => ({
          name: adapter.name,
          layer: adapter.layer,
          sourceType: adapter.sourceType,
          ...(adapters[index] ?? { ok: false, detail: 'No health result' })
        }))
      })
      return
    }
    if (!authorized(request, options.token)) {
      json(response, 401, { error: 'unauthorized', traceId })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/context/resolve') {
      const body = await readJson(request)
      const resolution = await options.resolver.resolveWithAudit(body, traceId)
      await options.activity.saveMeter(resolution.capsule, resolution.evidenceAudit)
      json(response, 200, resolution.capsule)
      return
    }
    if (request.method === 'POST' && request.url === '/v1/sessions/start') {
      const body = startSessionRequestSchema.parse(await readJson(request))
      const session = await options.activity.startSession(body)
      const resolution = await options.resolver.resolveWithAudit(
        {
          objective: body.objective,
          ...(session.project ? { projectHint: session.project.name } : {}),
          constraints: body.constraints,
          tokenBudget: body.tokenBudget,
          client: body.client,
          workflow: 'session_start'
        },
        session.traceId
      )
      await options.activity.saveCapsule({
        session,
        capsule: resolution.capsule,
        evidenceAudit: resolution.evidenceAudit
      })
      json(response, 200, { session, capsule: resolution.capsule })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/activity/record') {
      const body = recordActivityRequestSchema.parse(await readJson(request))
      const result = await options.activity.recordActivity(body, 'http')
      json(response, 200, result)
      return
    }
    if (request.method === 'POST' && request.url === '/v1/sessions/complete') {
      const body = completeSessionRequestSchema.parse(await readJson(request))
      const result = await options.activity.completeSession(body, 'http')
      json(response, 200, result)
      return
    }
    if (request.method === 'POST' && request.url === '/v1/metrics/context') {
      const body = contextMeterSummaryRequestSchema.parse(await readJson(request))
      const summary = await options.activity.contextMeterSummary(body)
      json(response, 200, summary)
      return
    }
    if (request.method === 'POST' && request.url === '/v1/metrics/context/inspect') {
      const body = contextMeterAuditRequestSchema.parse(await readJson(request))
      const audit = await options.activity.contextMeterAudit(body)
      json(response, 200, audit)
      return
    }
    json(response, 404, { error: 'not_found', traceId })
  } catch (error) {
    if (error instanceof ZodError) {
      json(response, 400, {
        error: 'invalid_request',
        traceId,
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      })
      return
    }
    if (error instanceof BodyTooLargeError) {
      json(response, 413, { error: 'body_too_large', traceId })
      return
    }
    json(response, 500, { error: 'internal_error', traceId })
  }
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return false
  const supplied = header.slice('Bearer '.length)
  const left = createHash('sha256').update(supplied).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  response.end(payload)
}

function headerTraceId(request: IncomingMessage): string | null {
  const value = request.headers['x-boron-trace-id']
  if (typeof value !== 'string') return null
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : null
}

function assertSafeHost(host: string): void {
  const allowed = new Set(['127.0.0.1', '::1', 'localhost'])
  if (!allowed.has(host) && process.env.BORON_ALLOW_REMOTE !== 'true') {
    throw new Error(
      `Refusing to bind Boron Context to non-loopback host ${host}; set BORON_ALLOW_REMOTE=true only behind an authenticated network boundary.`
    )
  }
}

class BodyTooLargeError extends Error {}

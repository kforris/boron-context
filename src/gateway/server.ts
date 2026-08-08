import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z, ZodError } from 'zod'
import type { ContextAdapter } from '../core/context-adapter.js'
import {
  adoptionHealthRequestSchema,
  agentClientObservationSchema,
  codexThreadSyncRequestSchema,
  completeSessionRequestSchema,
  contextMeterAuditRequestSchema,
  contextQualityHealthRequestSchema,
  contextMeterSummaryRequestSchema,
  inspectorScopeSchema,
  lifecycleSessionEndRequestSchema,
  listManualCorrectionsSchema,
  manualCorrectionSchema,
  recordActivityRequestSchema,
  resolveManualCorrectionSchema,
  spatialCodebaseExpandRequestSchema,
  spatialCodebaseGraphRequestSchema,
  startSessionRequestSchema
} from '../core/contracts.js'
import { ActivityTimestampError, ProjectScopeError } from '../core/errors.js'
import type { ContextResolver } from '../core/resolver.js'
import type { PostgresActivityRepository } from '../db/activity-repository.js'
import type { PostgresCodexThreadRepository } from '../db/codex-thread-repository.js'
import type { PostgresInspectorRepository } from '../db/inspector-repository.js'
import { inspectorHtml } from '../inspector/app.js'
import {
  loadSpatialCodebaseGraph,
  loadSpatialCodebaseNeighborhood
} from '../inspector/codebase-spatial.js'
import { spatialInspectorHtml } from '../inspector/spatial-app.js'
import { readThreeAsset } from '../inspector/three-assets.js'

const MAX_BODY_BYTES = 256 * 1024
const INSPECTOR_TICKET_TTL_MS = 60_000
const INSPECTOR_SESSION_TTL_MS = 8 * 60 * 60 * 1_000
const INSPECTOR_COOKIE = 'boron_inspector_session'
const inspectorSessionRequestSchema = z.object({ ticket: z.string().uuid() })
const inspectorTicketRequestSchema = z.object({
  mode: z.enum(['standard', 'spatial']).default('standard')
})

export interface GatewayOptions {
  readonly host: string
  readonly port: number
  readonly token: string
  readonly resolver: ContextResolver
  readonly activity: PostgresActivityRepository
  readonly codexThreads: PostgresCodexThreadRepository
  readonly inspector: PostgresInspectorRepository
  readonly codebaseMemoryGraphUrl: string
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
  const inspectorSessions = new InspectorSessionStore()
  const server = createServer((request, response) => {
    void routeRequest(options, inspectorSessions, request, response)
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
  inspectorSessions: InspectorSessionStore,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const traceId = headerTraceId(request) ?? randomUUID()
  const pathname = request.url ? new URL(request.url, 'http://localhost').pathname : '/'
  response.setHeader('x-boron-trace-id', traceId)
  try {
    if (request.method === 'GET' && pathname === '/health') {
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
    if (request.method === 'GET' && pathname === '/inspector') {
      const nonce = randomBytes(18).toString('base64')
      html(
        response,
        inspectorHtml(nonce, options.codebaseMemoryGraphUrl),
        nonce,
        options.codebaseMemoryGraphUrl
      )
      return
    }
    if (request.method === 'GET' && pathname === '/inspector/spatial') {
      const nonce = randomBytes(18).toString('base64')
      html(response, spatialInspectorHtml(nonce), nonce, options.codebaseMemoryGraphUrl)
      return
    }
    if (request.method === 'GET' && pathname === '/inspector/assets/three.module.js') {
      javascript(response, await readThreeAsset('three.module.js')!)
      return
    }
    if (request.method === 'GET' && pathname === '/inspector/assets/three.core.min.js') {
      javascript(response, await readThreeAsset('three.core.min.js')!)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/session') {
      const body = inspectorSessionRequestSchema.parse(await readJson(request))
      const session = inspectorSessions.exchange(body.ticket)
      if (!session) {
        json(response, 401, { error: 'invalid_or_expired_ticket', traceId })
        return
      }
      response.setHeader(
        'set-cookie',
        `${INSPECTOR_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(INSPECTOR_SESSION_TTL_MS / 1_000)}`
      )
      json(response, 200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt })
      return
    }
    const authorization = authorize(request, options.token, inspectorSessions)
    if (!authorization) {
      json(response, 401, { error: 'unauthorized', traceId })
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/ticket') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
      const body = inspectorTicketRequestSchema.parse(await readJson(request))
      const ticket = inspectorSessions.issueTicket()
      const launchId = randomUUID()
      json(response, 200, {
        ticket: ticket.id,
        url: `${body.mode === 'spatial' ? '/inspector/spatial' : '/inspector'}?launch=${launchId}#ticket=${ticket.id}`,
        expiresAt: ticket.expiresAt
      })
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/ontology') {
      const body = inspectorScopeSchema.parse(await readJson(request))
      json(response, 200, await options.inspector.ontologyGraph(body))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/wiki') {
      inspectorScopeSchema.parse(await readJson(request))
      json(response, 200, await options.inspector.wiki())
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/codebase-spatial') {
      const body = spatialCodebaseGraphRequestSchema.parse(await readJson(request))
      json(
        response,
        200,
        await loadSpatialCodebaseGraph(options.codebaseMemoryGraphUrl, body.project)
      )
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/codebase-spatial-expand') {
      const body = spatialCodebaseExpandRequestSchema.parse(await readJson(request))
      json(
        response,
        200,
        await loadSpatialCodebaseNeighborhood(
          options.codebaseMemoryGraphUrl,
          body.project,
          body.symbol
        )
      )
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/corrections/list') {
      const body = listManualCorrectionsSchema.parse(await readJson(request))
      json(response, 200, await options.inspector.listCorrections(body))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/corrections/create') {
      if (!mutationAuthorized(request, authorization)) {
        json(response, 403, { error: 'invalid_csrf_token', traceId })
        return
      }
      const body = manualCorrectionSchema.parse(await readJson(request))
      json(response, 201, await options.inspector.createCorrection(body))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/corrections/resolve') {
      if (!mutationAuthorized(request, authorization)) {
        json(response, 403, { error: 'invalid_csrf_token', traceId })
        return
      }
      const body = resolveManualCorrectionSchema.parse(await readJson(request))
      const correction = await options.inspector.resolveCorrection(body)
      if (!correction) {
        json(response, 404, { error: 'pending_correction_not_found', traceId })
        return
      }
      json(response, 200, correction)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/context/resolve') {
      const body = await readJson(request)
      const resolution = await options.resolver.resolveWithAudit(body, traceId)
      await options.activity.saveMeter(resolution.capsule, resolution.evidenceAudit)
      json(response, 200, resolution.capsule)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/clients/observe') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
      const body = agentClientObservationSchema.parse(await readJson(request))
      await options.activity.observeAgentClient(body)
      json(response, 200, { observed: true })
      return
    }
    if (request.method === 'POST' && pathname === '/v1/imports/codex-threads') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
      const body = codexThreadSyncRequestSchema.parse(await readJson(request))
      json(response, 200, await options.codexThreads.sync(body))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/sessions/start') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
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
    if (request.method === 'POST' && pathname === '/v1/sessions/bootstrap') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
      const body = startSessionRequestSchema.parse(await readJson(request))
      const session = await options.activity.bootstrapSession(body)
      if (!session) {
        json(response, 200, {
          started: false,
          reason: 'project_unresolved',
          session: null,
          capsule: null
        })
        return
      }
      const resolution = await options.resolver.resolveWithAudit(
        {
          objective: body.objective,
          projectHint: session.project!.name,
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
      json(response, 200, { started: true, session, capsule: resolution.capsule })
      return
    }
    if (request.method === 'POST' && pathname === '/v1/activity/record') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
      const body = recordActivityRequestSchema.parse(await readJson(request))
      const result = await options.activity.recordActivity(body, 'http')
      json(response, 200, result)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/sessions/complete') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
      const body = completeSessionRequestSchema.parse(await readJson(request))
      const result = await options.activity.completeSession(body, 'http')
      json(response, 200, result)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/sessions/lifecycle-end') {
      if (authorization.kind !== 'bearer') {
        json(response, 403, { error: 'bearer_token_required', traceId })
        return
      }
      const body = lifecycleSessionEndRequestSchema.parse(await readJson(request))
      json(response, 200, await options.activity.endSessionFromClientLifecycle(body))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/metrics/context') {
      const body = contextMeterSummaryRequestSchema.parse(await readJson(request))
      const summary = await options.activity.contextMeterSummary(body)
      json(response, 200, summary)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/metrics/context/inspect') {
      const body = contextMeterAuditRequestSchema.parse(await readJson(request))
      const audit = await options.activity.contextMeterAudit(body)
      json(response, 200, audit)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/metrics/context/quality') {
      const body = contextQualityHealthRequestSchema.parse(await readJson(request))
      json(response, 200, await options.activity.contextQualityHealth(body))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/metrics/adoption') {
      const body = adoptionHealthRequestSchema.parse(await readJson(request))
      json(response, 200, await options.activity.adoptionHealth(body))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/metrics/codex-sync') {
      json(response, 200, await options.codexThreads.health())
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
    if (error instanceof ProjectScopeError) {
      json(response, 409, { error: error.reason, traceId })
      return
    }
    if (error instanceof ActivityTimestampError) {
      json(response, 400, { error: 'invalid_activity_timestamp', traceId })
      return
    }
    json(response, 500, { error: 'internal_error', traceId })
  }
}

type Authorization =
  { readonly kind: 'bearer' } | { readonly kind: 'inspector'; readonly csrfToken: string }

function authorize(
  request: IncomingMessage,
  expected: string,
  inspectorSessions: InspectorSessionStore
): Authorization | null {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const supplied = header.slice('Bearer '.length)
    if (secretsEqual(supplied, expected)) return { kind: 'bearer' }
  }
  const sessionId = cookieValue(request, INSPECTOR_COOKIE)
  const session = sessionId ? inspectorSessions.session(sessionId) : null
  return session ? { kind: 'inspector', csrfToken: session.csrfToken } : null
}

function mutationAuthorized(request: IncomingMessage, authorization: Authorization): boolean {
  if (authorization.kind === 'bearer') return true
  const supplied = request.headers['x-boron-csrf']
  return typeof supplied === 'string' && secretsEqual(supplied, authorization.csrfToken)
}

function secretsEqual(leftValue: string, rightValue: string): boolean {
  const left = createHash('sha256').update(leftValue).digest()
  const right = createHash('sha256').update(rightValue).digest()
  return timingSafeEqual(left, right)
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie
  if (!header) return null
  for (const item of header.split(';')) {
    const [key, ...value] = item.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return null
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

function javascript(response: ServerResponse, body: Buffer): void {
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff'
  })
  response.end(body)
}

function html(
  response: ServerResponse,
  body: string,
  nonce: string,
  codebaseMemoryUrl: string
): void {
  const codebaseMemoryOrigin = new URL(codebaseMemoryUrl).origin
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'self'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}' 'self'`,
      `frame-src ${codebaseMemoryOrigin}`,
      `connect-src 'self' ${codebaseMemoryOrigin}`,
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  })
  response.end(body)
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

interface InspectorTicket {
  readonly id: string
  readonly expiresAt: string
}

interface InspectorSession {
  readonly id: string
  readonly csrfToken: string
  readonly expiresAt: string
}

class InspectorSessionStore {
  private readonly tickets = new Map<string, number>()
  private readonly sessions = new Map<string, { expiresAt: number; csrfToken: string }>()

  issueTicket(): InspectorTicket {
    this.purge()
    const id = randomUUID()
    const expiresAt = Date.now() + INSPECTOR_TICKET_TTL_MS
    this.tickets.set(id, expiresAt)
    return { id, expiresAt: new Date(expiresAt).toISOString() }
  }

  exchange(ticket: string): InspectorSession | null {
    this.purge()
    const ticketExpiry = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!ticketExpiry || ticketExpiry <= Date.now()) return null
    const id = randomUUID()
    const csrfToken = randomUUID()
    const expiresAt = Date.now() + INSPECTOR_SESSION_TTL_MS
    this.sessions.set(id, { expiresAt, csrfToken })
    return { id, csrfToken, expiresAt: new Date(expiresAt).toISOString() }
  }

  session(id: string): InspectorSession | null {
    this.purge()
    const session = this.sessions.get(id)
    if (!session) return null
    return {
      id,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString()
    }
  }

  private purge(): void {
    const now = Date.now()
    for (const [id, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(id)
    }
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id)
    }
  }
}

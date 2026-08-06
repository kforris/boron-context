import { randomBytes } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { ZodError } from 'zod'
import {
  inspectorScopeSchema,
  spatialCodebaseExpandRequestSchema,
  spatialCodebaseGraphRequestSchema
} from '../core/contracts.js'
import { spatialInspectorHtml } from '../inspector/spatial-app.js'
import { readThreeAsset } from '../inspector/three-assets.js'
import { isPrivateIpv4 } from '../platform/lan-mr-config.js'
import { LanMrPairingAuthority, lanMrSessionTtlSeconds } from './lan-mr-auth.js'

const SESSION_COOKIE = 'boron_lan_mr'
const MAX_BODY_BYTES = 64 * 1024
const PAIR_FAILURE_LIMIT = 5
const PAIR_FAILURE_WINDOW_MS = 5 * 60 * 1_000

class LanMrBodyTooLargeError extends Error {}

export interface RunningLanMrGateway {
  readonly bootstrapUrl: string
  readonly secureUrl: string
  close(): Promise<void>
}

export async function startLanMrGateway(options: {
  readonly host: string
  readonly hostname: string
  readonly bootstrapPort: number
  readonly httpsPort: number
  readonly certificate: Buffer
  readonly privateKey: Buffer
  readonly caCertificate: Buffer
  /** Compare this value with the trusted Mac CLI before installing the CA from HTTP bootstrap. */
  readonly caFingerprint256: string
  readonly daemonUrl: string
  readonly daemonToken: string
  readonly pairing: LanMrPairingAuthority
}): Promise<RunningLanMrGateway> {
  const allowedHosts = new Set([options.host.toLowerCase(), options.hostname.toLowerCase()])
  const secureUrl = `https://${options.host}:${options.httpsPort}`
  const bootstrapServer = createHttpServer((request, response) => {
    void handleBootstrap(options, allowedHosts, secureUrl, request, response)
  })
  const pairFailures = new Map<string, { count: number; startedAt: number }>()
  const secureServer = createHttpsServer(
    {
      cert: options.certificate,
      key: options.privateKey,
      minVersion: 'TLSv1.2'
    },
    (request, response) => {
      void handleSecure(options, allowedHosts, pairFailures, request, response)
    }
  )
  await Promise.all([
    listen(bootstrapServer, options.bootstrapPort, options.host),
    listen(secureServer, options.httpsPort, options.host)
  ]).catch(async (error) => {
    await Promise.all([closeServer(bootstrapServer), closeServer(secureServer)])
    throw error
  })
  const bootstrapAddress = bootstrapServer.address() as AddressInfo
  const secureAddress = secureServer.address() as AddressInfo
  return {
    bootstrapUrl: `http://${options.host}:${bootstrapAddress.port}`,
    secureUrl: `https://${options.host}:${secureAddress.port}`,
    close: () =>
      Promise.all([closeServer(bootstrapServer), closeServer(secureServer)]).then(() => {})
  }
}

async function handleBootstrap(
  options: Parameters<typeof startLanMrGateway>[0],
  allowedHosts: ReadonlySet<string>,
  secureUrl: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  applyCommonHeaders(response)
  if (!validRequestBoundary(request, allowedHosts)) {
    json(response, 403, { error: 'lan_boundary_rejected' })
    return
  }
  const pathname = request.url ? new URL(request.url, 'http://boron.local').pathname : '/'
  if (request.method === 'GET' && pathname === '/health') {
    json(response, 200, { ok: true, service: 'boron-lan-mr-bootstrap', secureDataSurface: false })
    return
  }
  if (request.method === 'GET' && pathname === '/boron-lan-ca.crt') {
    response.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-length': options.caCertificate.byteLength,
      'content-disposition': 'attachment; filename="boron-lan-mr-ca.crt"',
      'cache-control': 'no-store'
    })
    response.end(options.caCertificate)
    return
  }
  if (request.method === 'GET' && pathname === '/') {
    const nonce = randomBytes(18).toString('base64')
    html(
      response,
      bootstrapHtml(nonce, secureUrl, options.caFingerprint256),
      nonce,
      "default-src 'none'; style-src 'nonce-{{nonce}}'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    )
    return
  }
  json(response, 404, { error: 'not_found' })
}

async function handleSecure(
  options: Parameters<typeof startLanMrGateway>[0],
  allowedHosts: ReadonlySet<string>,
  pairFailures: Map<string, { count: number; startedAt: number }>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  applyCommonHeaders(response)
  if (!validRequestBoundary(request, allowedHosts)) {
    json(response, 403, { error: 'lan_boundary_rejected' })
    return
  }
  const clientAddress = normalizedClientAddress(request.socket.remoteAddress)
  const pathname = request.url ? new URL(request.url, 'https://boron.local').pathname : '/'
  try {
    if (request.method === 'GET' && pathname === '/health') {
      json(response, 200, { ok: true, service: 'boron-lan-mr', mode: 'paired_read_only' })
      return
    }
    if (request.method === 'GET' && (pathname === '/' || pathname === '/pair')) {
      if (hasSession(request, options.pairing, clientAddress)) {
        redirect(response, '/inspector/spatial')
        return
      }
      const nonce = randomBytes(18).toString('base64')
      html(
        response,
        pairingHtml(nonce),
        nonce,
        "default-src 'none'; style-src 'nonce-{{nonce}}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
      )
      return
    }
    if (request.method === 'POST' && pathname === '/pair') {
      if (rateLimited(pairFailures, clientAddress)) {
        json(response, 429, { error: 'pairing_rate_limited' })
        return
      }
      const code = await readPairingCode(request)
      const session = await options.pairing.exchange(code, clientAddress)
      if (!session) {
        recordPairFailure(pairFailures, clientAddress)
        const nonce = randomBytes(18).toString('base64')
        html(
          response,
          pairingHtml(nonce, 'The code is invalid, expired, or already used.'),
          nonce,
          "default-src 'none'; style-src 'nonce-{{nonce}}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          401
        )
        return
      }
      pairFailures.delete(clientAddress)
      response.setHeader(
        'set-cookie',
        `${SESSION_COOKIE}=${session}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lanMrSessionTtlSeconds}`
      )
      redirect(response, '/inspector/spatial')
      return
    }

    if (!hasSession(request, options.pairing, clientAddress)) {
      if (request.method === 'GET') redirect(response, '/pair')
      else json(response, 401, { error: 'pairing_required' })
      return
    }
    if (request.method === 'GET' && pathname === '/inspector/spatial') {
      const nonce = randomBytes(18).toString('base64')
      html(
        response,
        spatialInspectorHtml(nonce, { backHref: '/pair', backLabel: 'Connection status' }),
        nonce,
        "default-src 'self'; style-src 'nonce-{{nonce}}'; script-src 'nonce-{{nonce}}' 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      )
      return
    }
    if (request.method === 'GET' && pathname.startsWith('/inspector/assets/')) {
      const asset = readThreeAsset(pathname.slice('/inspector/assets/'.length))
      if (!asset) {
        json(response, 404, { error: 'asset_not_found' })
        return
      }
      javascript(response, await asset)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/ontology') {
      const body = inspectorScopeSchema.parse(await readJson(request))
      await forwardRead(options, pathname, body, response)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/codebase-spatial') {
      const body = spatialCodebaseGraphRequestSchema.parse(await readJson(request))
      await forwardRead(options, pathname, body, response)
      return
    }
    if (request.method === 'POST' && pathname === '/v1/inspector/codebase-spatial-expand') {
      const body = spatialCodebaseExpandRequestSchema.parse(await readJson(request))
      await forwardRead(options, pathname, body, response)
      return
    }
    if (pathname.startsWith('/v1/')) {
      json(response, 403, { error: 'read_only_surface' })
      return
    }
    json(response, 404, { error: 'not_found' })
  } catch (error) {
    if (error instanceof ZodError || (error as Error).message === 'invalid_json') {
      json(response, 400, { error: 'invalid_request' })
      return
    }
    if (error instanceof LanMrBodyTooLargeError) {
      json(response, 413, { error: 'body_too_large' })
      return
    }
    console.error('Boron LAN MR request failed:', error instanceof Error ? error.message : error)
    json(response, 502, { error: 'lan_gateway_failure' })
  }
}

async function forwardRead(
  options: Parameters<typeof startLanMrGateway>[0],
  pathname: string,
  body: unknown,
  response: ServerResponse
): Promise<void> {
  // The caller reaches this function only through the three explicit read-route branches above.
  // Never replace that allowlist with a generic daemon proxy: the paired surface is intentionally
  // incapable of lifecycle, activity, correction, or other semantic writes.
  const upstream = await fetch(`${options.daemonUrl}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.daemonToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7_000)
  })
  const payload = Buffer.from(await upstream.arrayBuffer())
  response.writeHead(upstream.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(payload)
}

function validRequestBoundary(
  request: IncomingMessage,
  allowedHosts: ReadonlySet<string>
): boolean {
  const client = normalizedClientAddress(request.socket.remoteAddress)
  if (!(client === '127.0.0.1' || isPrivateIpv4(client))) return false
  const rawHost = request.headers.host
  if (!rawHost) return false
  try {
    const hostname = new URL(`https://${rawHost}`).hostname.toLowerCase().replace(/\.$/, '')
    return allowedHosts.has(hostname)
  } catch {
    return false
  }
}

function hasSession(
  request: IncomingMessage,
  authority: LanMrPairingAuthority,
  clientAddress: string
): boolean {
  return authority.verifySession(cookie(request.headers.cookie, SESSION_COOKIE), clientAddress)
}

function normalizedClientAddress(value: string | undefined): string {
  return (value ?? '').replace(/^::ffff:/, '')
}

function cookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)
    ?.slice(1)
    .join('=')
}

async function readPairingCode(request: IncomingMessage): Promise<string> {
  const body = await readBody(request)
  const contentType = request.headers['content-type'] ?? ''
  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(body) as { code?: unknown }
    return typeof parsed.code === 'string' ? parsed.code.trim() : ''
  }
  return new URLSearchParams(body).get('code')?.trim() ?? ''
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(request))
  } catch (error) {
    if (error instanceof LanMrBodyTooLargeError) throw error
    throw new Error('invalid_json')
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += data.length
    if (total > MAX_BODY_BYTES) throw new LanMrBodyTooLargeError()
    chunks.push(data)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function rateLimited(
  failures: Map<string, { count: number; startedAt: number }>,
  client: string
): boolean {
  const entry = failures.get(client)
  if (!entry) return false
  if (Date.now() - entry.startedAt >= PAIR_FAILURE_WINDOW_MS) {
    failures.delete(client)
    return false
  }
  return entry.count >= PAIR_FAILURE_LIMIT
}

function recordPairFailure(
  failures: Map<string, { count: number; startedAt: number }>,
  client: string
): void {
  const entry = failures.get(client)
  if (!entry || Date.now() - entry.startedAt >= PAIR_FAILURE_WINDOW_MS) {
    failures.set(client, { count: 1, startedAt: Date.now() })
  } else {
    entry.count += 1
  }
}

function bootstrapHtml(nonce: string, secureUrl: string, caFingerprint256: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Boron Quest setup</title><style nonce="${nonce}">${pageStyles()}</style></head><body><main><div class="mark">B</div><p class="eyebrow">BORON LAN MR</p><h1>Trust once. Enter wirelessly.</h1><p>This bootstrap page exposes no project data. Install the local Boron CA on this Quest, then continue to the paired HTTPS Inspector.</p><ol><li>On the Mac, run <code>boron-context lan-inspector pair</code> and compare its CA SHA-256 fingerprint with <code class="fingerprint">${escapeHtml(caFingerprint256)}</code>. Stop if they differ.</li><li><a class="button" href="/boron-lan-ca.crt">Download Boron LAN certificate</a></li><li>Install it as a trusted CA in the Quest certificate settings.</li><li><a class="button primary" href="${escapeHtml(secureUrl)}/pair">Open secure pairing</a></li></ol><p class="muted">The privileged Boron daemon remains on Mac loopback. Only the paired read-only spatial graph is available here.</p></main></body></html>`
}

function pairingHtml(nonce: string, error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair Boron Spatial</title><style nonce="${nonce}">${pageStyles()}</style></head><body><main><div class="mark">B</div><p class="eyebrow">BORON SPATIAL</p><h1>Pair this Quest</h1><p>On the Mac, run <code>boron-context lan-inspector pair</code>. Enter the six-digit code below. It expires after five minutes and is consumed once.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<form method="post" action="/pair"><label for="code">Pairing code</label><input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus><button class="primary" type="submit">Connect read-only Inspector</button></form><p class="muted">Paired access lasts eight hours and cannot call Boron write endpoints.</p></main></body></html>`
}

function pageStyles(): string {
  return `:root{color-scheme:dark;--bg:#070c0a;--panel:#0f1915;--line:#34453e;--text:#f4f8f6;--muted:#a7b2ad;--acid:#a8ff4f;--error:#ff9b82}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 25%,#1c2a24,#070c0a 65%);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(620px,100%);padding:30px;border:1px solid var(--line);border-radius:20px;background:color-mix(in srgb,var(--panel) 94%,transparent);box-shadow:0 26px 90px #0008}.mark{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:var(--acid);color:#08100c;font-weight:900}.eyebrow{margin:20px 0 4px;color:var(--acid);font-size:12px;letter-spacing:.14em;font-weight:800}h1{margin:0 0 12px;font-size:clamp(28px,6vw,44px);line-height:1.05}p{color:var(--muted)}ol{padding-left:22px}li{margin:14px 0}.button,button{display:inline-block;border:1px solid #52665c;border-radius:11px;padding:11px 14px;background:#17241f;color:var(--text);text-decoration:none;font:inherit;cursor:pointer}.primary{border-color:var(--acid);background:var(--acid);color:#08100c;font-weight:800}form{display:grid;gap:12px;margin:24px 0}label{font-size:13px;color:var(--muted)}input{width:100%;border:1px solid #52665c;border-radius:12px;padding:14px;background:#0a120f;color:var(--text);font:700 28px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.28em;text-align:center}.muted{font-size:13px}.error{padding:10px 12px;border:1px solid #704338;border-radius:10px;color:var(--error);background:#291510}.fingerprint{display:block;margin-top:8px;overflow-wrap:anywhere}code{padding:2px 5px;border-radius:5px;background:#18231f;color:#dfffc1;font-size:.9em}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return entities[character]!
  })
}

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()')
}

function html(
  response: ServerResponse,
  body: string,
  nonce: string,
  policyTemplate: string,
  status = 200
): void {
  const payload = Buffer.from(body)
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': payload.byteLength,
    'content-security-policy': policyTemplate.replaceAll('{{nonce}}', nonce)
  })
  response.end(payload)
}

function javascript(response: ServerResponse, body: Buffer): void {
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'public, max-age=31536000, immutable'
  })
  response.end(body)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.byteLength
  })
  response.end(payload)
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, 'content-length': 0 })
  response.end()
}

function listen(
  server: ReturnType<typeof createHttpServer>,
  port: number,
  host: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

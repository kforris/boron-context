import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LanMrPairingAuthority } from '../src/gateway/lan-mr-auth.js'
import { startLanMrGateway } from '../src/gateway/lan-mr-server.js'
import { ensureLanMrCertificates } from '../src/platform/lan-mr-certificates.js'
import { detectLanIpv4 } from '../src/platform/lan-mr-config.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

describe('LAN MR address discovery', () => {
  it('prefers the primary private interface and rejects ambiguous equal-priority interfaces', () => {
    expect(
      detectLanIpv4({
        bridge0: [address('192.168.60.3')],
        en0: [address('192.168.50.23')]
      })
    ).toBe('192.168.50.23')
    expect(() =>
      detectLanIpv4({
        en0: [address('192.168.50.23')],
        wlan0: [address('10.0.0.4')]
      })
    ).toThrow(/Multiple LAN interfaces/)
  })
})

describe('paired read-only LAN MR gateway', () => {
  it('uses a trusted TLS surface, consumes pair codes once, and never forwards writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'boron-lan-mr-test-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const certificates = await ensureLanMrCertificates({
      directory: join(directory, 'certificates'),
      host: '127.0.0.1',
      hostname: 'localhost',
      opensslCommand: '/usr/bin/openssl'
    })
    const pairing = await LanMrPairingAuthority.create({
      pairingSecretPath: join(directory, 'pairing.secret'),
      sessionSecretPath: join(directory, 'session.secret'),
      clock: () => Date.UTC(2026, 7, 6, 12, 0, 0)
    })
    const upstreamPaths: string[] = []
    const daemon = createServer((request, response) => {
      upstreamPaths.push(request.url ?? '')
      if (request.headers.authorization !== 'Bearer daemon-test-token-that-is-long-enough') {
        response.writeHead(401).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, path: request.url }))
    })
    await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise((resolve) => daemon.close(() => resolve())))
    const daemonPort = (daemon.address() as AddressInfo).port
    const gateway = await startLanMrGateway({
      host: '127.0.0.1',
      hostname: 'localhost',
      bootstrapPort: 0,
      httpsPort: 0,
      certificate: certificates.certificate,
      privateKey: certificates.privateKey,
      caCertificate: certificates.caCertificate,
      caFingerprint256: certificates.caFingerprint256,
      daemonUrl: `http://127.0.0.1:${daemonPort}`,
      daemonToken: 'daemon-test-token-that-is-long-enough',
      pairing
    })
    cleanup.push(() => gateway.close())

    const bootstrap = await fetch(`${gateway.bootstrapUrl}/health`)
    expect(await bootstrap.json()).toEqual({
      ok: true,
      service: 'boron-lan-mr-bootstrap',
      secureDataSurface: false
    })
    expect(certificates.caFingerprint256).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    const bootstrapPage = await fetch(gateway.bootstrapUrl)
    expect(await bootstrapPage.text()).toContain(certificates.caFingerprint256)
    const unpaired = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      path: '/inspector/spatial'
    })
    expect(unpaired.status).toBe(303)
    expect(unpaired.headers.location).toBe('/pair')

    const code = pairing.currentPairing().code
    const paired = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      method: 'POST',
      path: '/pair',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${code}`
    })
    expect(paired.status).toBe(303)
    const sessionCookie = paired.headers['set-cookie']?.[0]?.split(';')[0]
    expect(sessionCookie).toMatch(/^boron_lan_mr=/)

    const reused = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      method: 'POST',
      path: '/pair',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${code}`
    })
    expect(reused.status).toBe(401)

    const nextCode = pairing.currentPairing().code
    const wrongCode = nextCode === '000000' ? '000001' : '000000'
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
        method: 'POST',
        path: '/pair',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `code=${wrongCode}`
      })
      expect(failed.status).toBe(401)
    }
    const rateLimited = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      method: 'POST',
      path: '/pair',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${nextCode}`
    })
    expect(rateLimited.status).toBe(429)

    const spatial = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      path: '/inspector/spatial',
      headers: { cookie: sessionCookie! }
    })
    expect(spatial.status).toBe(200)
    expect(spatial.body).toContain('Boron Spatial Inspector')
    expect(spatial.body).toContain('L2 call graph')
    expect(spatial.body).toContain('two-hand pinch')
    expect(spatial.body).toContain('Quest performance')
    expect(spatial.body).toContain('measuring FPS')
    expect(spatial.body).toContain('0 camera frames captured')

    const graph = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      method: 'POST',
      path: '/v1/inspector/ontology',
      headers: { cookie: sessionCookie!, 'content-type': 'application/json' },
      body: JSON.stringify({ projectHint: 'Boron Context' })
    })
    expect(graph.status).toBe(200)
    expect(JSON.parse(graph.body)).toMatchObject({ ok: true, path: '/v1/inspector/ontology' })

    const expansion = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      method: 'POST',
      path: '/v1/inspector/codebase-spatial-expand',
      headers: { cookie: sessionCookie!, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'Users-test-Boron-Context', symbol: 'routeRequest' })
    })
    expect(expansion.status).toBe(200)

    const oversized = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      method: 'POST',
      path: '/v1/inspector/ontology',
      headers: { cookie: sessionCookie!, 'content-type': 'application/json' },
      body: JSON.stringify({ projectHint: 'x'.repeat(70 * 1024) })
    })
    expect(oversized.status).toBe(413)

    const write = await secureRequest(gateway.secureUrl, certificates.caCertificate, {
      method: 'POST',
      path: '/v1/activity/record',
      headers: { cookie: sessionCookie!, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(write.status).toBe(403)
    expect(upstreamPaths).toEqual([
      '/v1/inspector/ontology',
      '/v1/inspector/codebase-spatial-expand'
    ])
  })
})

function address(value: string) {
  return {
    address: value,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${value}/24`
  }
}

function secureRequest(
  baseUrl: string,
  ca: Buffer,
  input: {
    readonly method?: string
    readonly path: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  }
): Promise<{
  readonly status: number
  readonly headers: import('node:http').IncomingHttpHeaders
  readonly body: string
}> {
  const url = new URL(baseUrl)
  const options: RequestOptions = {
    hostname: url.hostname,
    port: Number(url.port),
    path: input.path,
    method: input.method ?? 'GET',
    ca,
    headers: input.headers
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest(options, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      )
    })
    request.once('error', reject)
    if (input.body) request.write(input.body)
    request.end()
  })
}

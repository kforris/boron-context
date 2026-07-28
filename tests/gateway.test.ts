import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ContextResolver } from '../src/core/resolver.js'
import { startGateway } from '../src/gateway/server.js'

describe('gateway', () => {
  it('serves health without exposing the token and protects context resolution', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => null },
      adapters: []
    })
    const gateway = await startGateway({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-with-at-least-thirty-two-characters',
      resolver,
      adapters: [],
      databaseHealth: async () => ({ ok: true }),
      version: '0.1.0'
    })
    try {
      const health = await fetch(`${gateway.url}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ ok: true, service: 'boron-context' })

      const unauthorized = await fetch(`${gateway.url}/v1/context/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective: 'test' })
      })
      expect(unauthorized.status).toBe(401)

      const traceId = randomUUID()
      const authorized = await fetch(`${gateway.url}/v1/context/resolve`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token-with-at-least-thirty-two-characters',
          'content-type': 'application/json',
          'x-boron-trace-id': traceId
        },
        body: JSON.stringify({ objective: 'Resolve a safe context capsule' })
      })
      expect(authorized.status).toBe(200)
      expect(authorized.headers.get('x-boron-trace-id')).toBe(traceId)
      expect(await authorized.json()).toMatchObject({ traceId })
    } finally {
      await gateway.close()
    }
  })
})

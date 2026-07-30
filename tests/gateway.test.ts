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
      activity: {
        startSession: async () => {
          throw new Error('not used')
        },
        recordActivity: async () => {
          throw new Error('not used')
        },
        completeSession: async () => {
          throw new Error('not used')
        },
        saveCapsule: async () => {
          throw new Error('not used')
        },
        saveMeter: async () => {},
        contextMeterSummary: async () => {
          throw new Error('not used')
        }
      } as never,
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

  it('routes the durable session lifecycle through the activity repository', async () => {
    const session = {
      id: randomUUID(),
      traceId: randomUUID(),
      intentionId: randomUUID(),
      project: {
        id: randomUUID(),
        name: 'Boron Context',
        confidence: 1
      }
    }
    const calls: string[] = []
    const resolver = new ContextResolver({
      projects: { resolve: async () => session.project },
      adapters: []
    })
    const gateway = await startGateway({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-with-at-least-thirty-two-characters',
      resolver,
      activity: {
        startSession: async () => {
          calls.push('start')
          return session
        },
        saveCapsule: async () => {
          calls.push('capsule')
        },
        saveMeter: async () => {
          calls.push('meter')
        },
        contextMeterSummary: async () => ({ samples: 1 }),
        recordActivity: async () => {
          calls.push('activity')
          return { id: randomUUID(), relationEffects: 0, evidence: 1, duplicate: false }
        },
        completeSession: async () => {
          calls.push('complete')
          return { id: randomUUID(), relationEffects: 0, evidence: 2, duplicate: false }
        }
      } as never,
      adapters: [],
      databaseHealth: async () => ({ ok: true }),
      version: '0.2.0'
    })
    const headers = {
      authorization: 'Bearer test-token-with-at-least-thirty-two-characters',
      'content-type': 'application/json'
    }
    try {
      const started = await fetch(`${gateway.url}/v1/sessions/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          objective: 'Continue durable project work',
          projectRoot: '/tmp/boron-context',
          projectHint: 'Boron Context',
          client: 'test'
        })
      })
      expect(started.status).toBe(200)
      expect(await started.json()).toMatchObject({ session: { id: session.id } })

      const activity = await fetch(`${gateway.url}/v1/activity/record`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: session.id,
          activityType: 'decision.recorded',
          summary: 'Activity belongs inside the ontology.'
        })
      })
      expect(activity.status).toBe(200)

      const completed = await fetch(`${gateway.url}/v1/sessions/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: session.id,
          outcome: 'completed',
          summary: 'The lifecycle passed.'
        })
      })
      expect(completed.status).toBe(200)

      const meter = await fetch(`${gateway.url}/v1/metrics/context`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectHint: 'Boron Context' })
      })
      expect(meter.status).toBe(200)
      expect(await meter.json()).toEqual({ samples: 1 })
      expect(calls).toEqual(['start', 'capsule', 'activity', 'complete'])
    } finally {
      await gateway.close()
    }
  })
})

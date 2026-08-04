import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ContextResolver } from '../src/core/resolver.js'
import { startGateway } from '../src/gateway/server.js'

function inspectorStub() {
  return {
    ontologyGraph: async () => ({
      project: { id: 'project-1', name: 'Boron Context' },
      projects: [],
      nodes: [],
      edges: [],
      pendingCorrections: []
    }),
    wiki: async () => ({ root: '/tmp/wiki', pages: [] }),
    listCorrections: async () => [],
    createCorrection: async (input: { subjectUri: string }) => ({
      id: randomUUID(),
      subjectUri: input.subjectUri,
      revision: 1,
      status: 'pending'
    }),
    resolveCorrection: async () => null
  } as never
}

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
        },
        contextMeterAudit: async () => {
          throw new Error('not used')
        }
      } as never,
      inspector: inspectorStub(),
      codebaseMemoryGraphUrl: 'http://127.0.0.1:9749',
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
        contextMeterAudit: async () => ({
          summary: { samples: 1 },
          samples: [{ id: 'audit-sample' }]
        }),
        recordActivity: async () => {
          calls.push('activity')
          return { id: randomUUID(), relationEffects: 0, evidence: 1, duplicate: false }
        },
        completeSession: async () => {
          calls.push('complete')
          return { id: randomUUID(), relationEffects: 0, evidence: 2, duplicate: false }
        }
      } as never,
      inspector: inspectorStub(),
      codebaseMemoryGraphUrl: 'http://127.0.0.1:9749',
      adapters: [],
      databaseHealth: async () => ({ ok: true }),
      version: '0.3.0'
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

      const audit = await fetch(`${gateway.url}/v1/metrics/context/inspect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectHint: 'Boron Context', limit: 5 })
      })
      expect(audit.status).toBe(200)
      expect(await audit.json()).toEqual({
        summary: { samples: 1 },
        samples: [{ id: 'audit-sample' }]
      })
      expect(calls).toEqual(['start', 'capsule', 'activity', 'complete'])
    } finally {
      await gateway.close()
    }
  })

  it('opens the Inspector through a one-time ticket and protects browser mutations with CSRF', async () => {
    const resolver = new ContextResolver({
      projects: { resolve: async () => null },
      adapters: []
    })
    const gateway = await startGateway({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-with-at-least-thirty-two-characters',
      resolver,
      activity: {} as never,
      inspector: inspectorStub(),
      codebaseMemoryGraphUrl: 'http://127.0.0.1:9749',
      adapters: [],
      databaseHealth: async () => ({ ok: true }),
      version: '0.3.0'
    })
    const bearerHeaders = {
      authorization: 'Bearer test-token-with-at-least-thirty-two-characters',
      'content-type': 'application/json'
    }
    try {
      const shell = await fetch(`${gateway.url}/inspector`)
      expect(shell.status).toBe(200)
      expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      const shellHtml = await shell.text()
      expect(shellHtml).toContain('Boron Content Inspector')
      expect(shellHtml).toContain('loadOntology(project.sourceUri)')

      const ticketResponse = await fetch(`${gateway.url}/v1/inspector/ticket`, {
        method: 'POST',
        headers: bearerHeaders,
        body: '{}'
      })
      expect(ticketResponse.status).toBe(200)
      const ticket = (await ticketResponse.json()) as { ticket: string; url: string }
      expect(ticket.url).toMatch(
        new RegExp(`^/inspector\\?launch=[0-9a-f-]+#ticket=${ticket.ticket}$`)
      )
      expect(ticket.url).not.toContain('test-token')

      const sessionResponse = await fetch(`${gateway.url}/v1/inspector/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: ticket.ticket })
      })
      expect(sessionResponse.status).toBe(200)
      const session = (await sessionResponse.json()) as { csrfToken: string }
      const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0]
      expect(cookie).toMatch(/^boron_inspector_session=/)

      const reusedTicket = await fetch(`${gateway.url}/v1/inspector/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: ticket.ticket })
      })
      expect(reusedTicket.status).toBe(401)

      const ontology = await fetch(`${gateway.url}/v1/inspector/ontology`, {
        method: 'POST',
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({ projectHint: 'Boron Context' })
      })
      expect(ontology.status).toBe(200)
      expect(await ontology.json()).toMatchObject({ project: { name: 'Boron Context' } })

      const correctionBody = JSON.stringify({
        projectHint: 'Boron Context',
        layer: 'ontology',
        subjectKind: 'entity',
        subjectUri: 'boron://entity/test',
        fields: { name: 'Reviewed name' },
        note: 'Verify this human correction.'
      })
      const missingCsrf = await fetch(`${gateway.url}/v1/inspector/corrections/create`, {
        method: 'POST',
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: correctionBody
      })
      expect(missingCsrf.status).toBe(403)

      const created = await fetch(`${gateway.url}/v1/inspector/corrections/create`, {
        method: 'POST',
        headers: {
          cookie: cookie!,
          'content-type': 'application/json',
          'x-boron-csrf': session.csrfToken
        },
        body: correctionBody
      })
      expect(created.status).toBe(201)
      expect(await created.json()).toMatchObject({ revision: 1, status: 'pending' })
    } finally {
      await gateway.close()
    }
  })
})

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { ContextResolver } from '../src/core/resolver.js'
import { OntologyGovernanceError, ProjectScopeError } from '../src/core/errors.js'
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

function codexThreadsStub(calls?: string[]) {
  return {
    sync: async (input: { observations: unknown[]; snapshotId: string }) => {
      calls?.push('codex-sync')
      return {
        snapshotId: input.snapshotId,
        duplicate: false,
        received: input.observations.length,
        confirmed: input.observations.length,
        candidate: 0,
        projectless: 0,
        unresolvedProjects: 0
      }
    },
    health: async () => {
      calls?.push('codex-sync-health')
      return {
        snapshots: 1,
        totalThreads: 1,
        confirmedThreads: 1,
        candidateThreads: 0,
        projectlessThreads: 0,
        conflictedThreads: 0,
        lastSnapshotAt: '2026-08-06T00:00:00.000Z'
      }
    }
  } as never
}

async function startFakeCodebaseGraph() {
  const server = createServer(async (request, response) => {
    if (request.url !== '/rpc') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      params?: { name?: string }
    }
    const result =
      rpc.params?.name === 'trace_path'
        ? {
            function: 'routeRequest',
            direction: 'both',
            mode: 'calls',
            callers: [{ name: 'startGateway', qualified_name: 'src.gateway.startGateway', hop: 1 }],
            callees: [{ name: 'authorize', qualified_name: 'src.gateway.authorize', hop: 1 }]
          }
        : {
            project: 'Users-test-Boron-Context',
            total_nodes: 1142,
            total_edges: 2512,
            clusters: [
              {
                id: 7,
                label: 'gateway',
                members: 22,
                cohesion: 0.8,
                top_nodes: ['routeRequest', 'authorize'],
                packages: ['src']
              }
            ]
          }
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    })
    response.end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
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
        },
        contextQualityHealth: async () => {
          throw new Error('not used')
        },
        ontologyGovernanceHealth: async () => {
          throw new Error('not used')
        },
        observeAgentClient: async () => {},
        adoptionHealth: async () => ({ observedAgentThreads: 0 })
      } as never,
      codexThreads: codexThreadsStub(),
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
        bootstrapSession: async () => {
          calls.push('bootstrap')
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
        contextQualityHealth: async () => ({
          project: 'Boron Context',
          writebackScope: { explicitVerificationRatio: 1 },
          timeIntegrity: { futureSkewedActivities: 0 }
        }),
        ontologyGovernanceHealth: async () => ({
          contractVersion: 1,
          windowDays: 30,
          registry: {
            entityKinds: { active: 20, legacy: 4, deprecated: 1 },
            relationTypes: { active: 12, legacy: 3, deprecated: 1 },
            sourceAuthorities: { system: 32, migration: 7, operator: 2 }
          },
          decisions: {
            accepted: 8,
            rejected: 1,
            deprecated: 2,
            reasons: {
              accepted: { active_registered_type: 8 },
              rejected: { unknown_entity_kind: 1 },
              deprecated: { deprecated_registered_type: 2 }
            }
          }
        }),
        recordActivity: async (input: { projectHint?: string; activityType?: string }) => {
          if (input.projectHint === 'Wrong Project') {
            throw new ProjectScopeError('project_mismatch', 'Wrong project')
          }
          if (input.activityType === 'governance.rejected') {
            throw new OntologyGovernanceError(
              'unknown_relation_type',
              [
                {
                  outcome: 'rejected',
                  reason: 'unknown_relation_type',
                  typeFamily: 'relation_type',
                  typeName: 'UNKNOWN'
                }
              ],
              'Unknown relation type'
            )
          }
          calls.push('activity')
          return { id: randomUUID(), relationEffects: 0, evidence: 1, duplicate: false }
        },
        completeSession: async () => {
          calls.push('complete')
          return { id: randomUUID(), relationEffects: 0, evidence: 2, duplicate: false }
        },
        endSessionFromClientLifecycle: async () => {
          calls.push('lifecycle-end')
          return {
            closed: true,
            sessionId: session.id,
            status: 'partial',
            reason: 'client_session_end'
          }
        },
        observeAgentClient: async () => {
          calls.push('observe')
        },
        adoptionHealth: async () => ({
          contractVersion: 2,
          windowDays: 7,
          observedAgentThreads: 1,
          contextThreads: 1,
          adoption: {
            numerator: 1,
            eligibleDenominator: 1,
            ratio: 1,
            ineligible: 0,
            unobservable: 0,
            reasons: { eligible: { semantic_context_work: 1 }, ineligible: {}, unobservable: {} }
          },
          writeback: {
            numerator: 1,
            eligibleDenominator: 1,
            ratio: 1,
            ineligible: 0,
            reasons: { eligible: { explicit_project: 1 }, ineligible: {} }
          }
        })
      } as never,
      codexThreads: codexThreadsStub(calls),
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

      const bootstrapped = await fetch(`${gateway.url}/v1/sessions/bootstrap`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          objective: 'Load automatic project continuity',
          projectRoot: '/tmp/boron-context',
          client: 'codex'
        })
      })
      expect(bootstrapped.status).toBe(200)
      expect(await bootstrapped.json()).toMatchObject({
        started: true,
        session: { id: session.id }
      })

      const observed = await fetch(`${gateway.url}/v1/clients/observe`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientInstanceId: 'thread-1',
          client: 'codex',
          event: 'session_started',
          sessionId: session.id
        })
      })
      expect(observed.status).toBe(200)

      const synced = await fetch(`${gateway.url}/v1/imports/codex-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          snapshotId: 'a'.repeat(64),
          client: 'codex',
          source: 'codex_hook',
          observedAt: '2026-08-06T00:00:00Z',
          observations: [
            {
              externalThreadId: 'thread-1',
              codexProjectId: 'project-1',
              classificationState: 'confirmed',
              authority: 'codex_project_assignment',
              confidence: 1,
              evidenceDigest: 'b'.repeat(64)
            }
          ]
        })
      })
      expect(synced.status).toBe(200)
      expect(await synced.json()).toMatchObject({ received: 1, confirmed: 1 })

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

      const mismatchedActivity = await fetch(`${gateway.url}/v1/activity/record`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: session.id,
          projectHint: 'Wrong Project',
          activityType: 'decision.recorded',
          summary: 'This must not cross project scope.'
        })
      })
      expect(mismatchedActivity.status).toBe(409)
      expect(await mismatchedActivity.json()).toMatchObject({ error: 'project_mismatch' })

      const governedActivity = await fetch(`${gateway.url}/v1/activity/record`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: session.id,
          projectHint: 'Boron Context',
          activityType: 'governance.rejected',
          summary: 'Unknown ontology vocabulary must be explicit.'
        })
      })
      expect(governedActivity.status).toBe(422)
      expect(await governedActivity.json()).toMatchObject({
        error: 'unknown_relation_type',
        contractVersion: 1,
        decisions: [{ outcome: 'rejected', reason: 'unknown_relation_type' }]
      })

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

      const lifecycleEnd = await fetch(`${gateway.url}/v1/sessions/lifecycle-end`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          externalSessionId: 'thread-1',
          client: 'codex'
        })
      })
      expect(lifecycleEnd.status).toBe(200)
      expect(await lifecycleEnd.json()).toMatchObject({
        closed: true,
        reason: 'client_session_end'
      })

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
      const quality = await fetch(`${gateway.url}/v1/metrics/context/quality`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectHint: 'Boron Context', windowDays: 30 })
      })
      expect(quality.status).toBe(200)
      expect(await quality.json()).toMatchObject({
        project: 'Boron Context',
        writebackScope: { explicitVerificationRatio: 1 },
        timeIntegrity: { futureSkewedActivities: 0 }
      })
      const governance = await fetch(`${gateway.url}/v1/metrics/ontology-governance`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectHint: 'Boron Context', windowDays: 30 })
      })
      expect(governance.status).toBe(200)
      expect(await governance.json()).toMatchObject({
        contractVersion: 1,
        decisions: { accepted: 8, rejected: 1, deprecated: 2 }
      })
      const adoption = await fetch(`${gateway.url}/v1/metrics/adoption`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ windowDays: 7 })
      })
      expect(adoption.status).toBe(200)
      expect(await adoption.json()).toMatchObject({
        contractVersion: 2,
        observedAgentThreads: 1,
        adoption: { numerator: 1, eligibleDenominator: 1 },
        writeback: { numerator: 1, eligibleDenominator: 1 }
      })
      const codexSyncHealth = await fetch(`${gateway.url}/v1/metrics/codex-sync`, {
        method: 'POST',
        headers,
        body: '{}'
      })
      expect(codexSyncHealth.status).toBe(200)
      expect(await codexSyncHealth.json()).toMatchObject({ confirmedThreads: 1 })
      expect(calls).toEqual([
        'start',
        'capsule',
        'bootstrap',
        'capsule',
        'observe',
        'codex-sync',
        'activity',
        'complete',
        'lifecycle-end',
        'codex-sync-health'
      ])
    } finally {
      await gateway.close()
    }
  })

  it('opens the Inspector through a one-time ticket and protects browser mutations with CSRF', async () => {
    const codebaseGraph = await startFakeCodebaseGraph()
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
      codexThreads: codexThreadsStub(),
      inspector: inspectorStub(),
      codebaseMemoryGraphUrl: codebaseGraph.url,
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
      expect(shellHtml).toContain('Auditable product health')
      expect(shellHtml).toContain('/v1/metrics/adoption')
      expect(shellHtml).toContain('/v1/metrics/ontology-governance')
      expect(shellHtml).toContain('loadOntology(project.sourceUri)')
      expect(shellHtml).toContain('Spatial MR')

      const spatialShell = await fetch(`${gateway.url}/inspector/spatial`)
      expect(spatialShell.status).toBe(200)
      expect(spatialShell.headers.get('content-security-policy')).toContain("script-src 'nonce-")
      const spatialHtml = await spatialShell.text()
      expect(spatialHtml).toContain('Boron Spatial Inspector')
      expect(spatialHtml).toContain("requestSession('immersive-ar'")
      expect(spatialHtml).toContain('L2 call graph')
      expect(spatialHtml).toContain('two-hand pinch')
      expect(spatialHtml).toContain('Quest performance')
      expect(spatialHtml).toContain('measuring FPS')
      expect(spatialHtml).toContain('0 camera frames captured')

      const threeModule = await fetch(`${gateway.url}/inspector/assets/three.module.js`)
      expect(threeModule.status).toBe(200)
      expect(threeModule.headers.get('content-type')).toContain('text/javascript')
      expect(await threeModule.text()).toContain('three.core.min.js')

      const threeCore = await fetch(`${gateway.url}/inspector/assets/three.core.min.js`)
      expect(threeCore.status).toBe(200)
      expect(threeCore.headers.get('content-type')).toContain('text/javascript')
      const threeCoreSource = await threeCore.text()
      expect(threeCoreSource).toContain('Three.js Authors')
      expect(threeCoreSource.length).toBeGreaterThan(100_000)

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

      const spatialTicketResponse = await fetch(`${gateway.url}/v1/inspector/ticket`, {
        method: 'POST',
        headers: bearerHeaders,
        body: JSON.stringify({ mode: 'spatial' })
      })
      expect(spatialTicketResponse.status).toBe(200)
      const spatialTicket = (await spatialTicketResponse.json()) as { url: string }
      expect(spatialTicket.url).toMatch(/^\/inspector\/spatial\?launch=/)

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

      const codebaseSpatial = await fetch(`${gateway.url}/v1/inspector/codebase-spatial`, {
        method: 'POST',
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'Users-test-Boron-Context' })
      })
      expect(codebaseSpatial.status).toBe(200)
      const codebaseSpatialBody = (await codebaseSpatial.json()) as {
        nodes: unknown[]
        edges: unknown[]
      }
      expect(codebaseSpatialBody).toMatchObject({
        project: 'Users-test-Boron-Context',
        sourceType: 'live',
        projection: 'architecture_clusters_lod_v2',
        original: { nodes: 1142, edges: 2512 }
      })
      expect(codebaseSpatialBody.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'routeRequest / authorize',
            kind: 'code_cluster',
            confirmationState: 'derived'
          }),
          expect.objectContaining({
            name: 'routeRequest',
            kind: 'code_symbol',
            confirmationState: 'derived'
          })
        ])
      )
      expect(codebaseSpatialBody.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relationType: 'SURFACES_TOP_NODE',
            confirmationState: 'derived'
          })
        ])
      )

      const codebaseExpansion = await fetch(`${gateway.url}/v1/inspector/codebase-spatial-expand`, {
        method: 'POST',
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({
          project: 'Users-test-Boron-Context',
          symbol: 'routeRequest'
        })
      })
      expect(codebaseExpansion.status).toBe(200)
      expect(await codebaseExpansion.json()).toEqual(
        expect.objectContaining({
          project: 'Users-test-Boron-Context',
          projection: 'call_neighborhood_lod_v1',
          focusLookupKey: 'routeRequest',
          truncated: false,
          edges: expect.arrayContaining([
            expect.objectContaining({ relationType: 'CALLS', confirmationState: 'derived' })
          ])
        })
      )

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

      const inspectorLifecycleMutation = await fetch(`${gateway.url}/v1/sessions/lifecycle-end`, {
        method: 'POST',
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({ externalSessionId: 'inspector-must-not-mutate' })
      })
      expect(inspectorLifecycleMutation.status).toBe(403)
      expect(await inspectorLifecycleMutation.json()).toMatchObject({
        error: 'bearer_token_required'
      })

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
      await codebaseGraph.close()
    }
  })
})

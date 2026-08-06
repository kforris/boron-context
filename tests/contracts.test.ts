import { describe, expect, it } from 'vitest'
import {
  agentClientObservationSchema,
  codexThreadProjectObservationSchema,
  codexThreadSyncRequestSchema,
  lifecycleSessionEndRequestSchema,
  manualCorrectionSchema,
  recordActivityRequestSchema,
  startSessionRequestSchema
} from '../src/core/contracts.js'

const activity = {
  sessionId: '00000000-0000-4000-8000-000000000000',
  activityType: 'test.activity',
  summary: 'Validate an activity timestamp'
}

describe('recordActivityRequestSchema', () => {
  it('accepts ISO 8601 timestamps with explicit timezone offsets', () => {
    expect(
      recordActivityRequestSchema.safeParse({
        ...activity,
        occurredAt: '2026-07-31T10:31:06-04:00'
      }).success
    ).toBe(true)
  })

  it('continues to reject invalid timestamps', () => {
    expect(
      recordActivityRequestSchema.safeParse({ ...activity, occurredAt: 'not-a-date' }).success
    ).toBe(false)
  })
})

describe('manualCorrectionSchema', () => {
  it('requires a human field edit or instruction', () => {
    const base = {
      layer: 'ontology',
      subjectKind: 'entity',
      subjectUri: 'boron://entity/test'
    }
    expect(manualCorrectionSchema.safeParse(base).success).toBe(false)
    expect(
      manualCorrectionSchema.safeParse({ ...base, note: 'Verify the relation owner.' }).success
    ).toBe(true)
  })
})

describe('agent continuity contracts', () => {
  it('defaults a durable session to a twelve-hour lease', () => {
    expect(
      startSessionRequestSchema.parse({ objective: 'Continue project work' }).leaseMinutes
    ).toBe(720)
  })

  it('accepts a bounded MCP client observation without conversation content', () => {
    expect(
      agentClientObservationSchema.parse({
        clientInstanceId: 'thread-1',
        client: 'codex',
        event: 'initialized'
      })
    ).toMatchObject({ event: 'initialized', metadata: {} })
  })

  it('requires only external identity for lifecycle ending', () => {
    expect(lifecycleSessionEndRequestSchema.parse({ externalSessionId: 'thread-1' })).toEqual({
      externalSessionId: 'thread-1',
      client: 'codex',
      metadata: {}
    })
  })

  it('requires confirmed Codex thread ownership to name a project', () => {
    const base = {
      externalThreadId: 'thread-1',
      authority: 'codex_project_assignment',
      confidence: 1,
      evidenceDigest: 'a'.repeat(64)
    }
    expect(
      codexThreadProjectObservationSchema.safeParse({
        ...base,
        classificationState: 'confirmed'
      }).success
    ).toBe(false)
    expect(
      codexThreadProjectObservationSchema.safeParse({
        ...base,
        codexProjectId: 'project-1',
        classificationState: 'confirmed'
      }).success
    ).toBe(true)
    expect(
      codexThreadProjectObservationSchema.safeParse({
        ...base,
        codexProjectId: 'project-1',
        classificationState: 'projectless'
      }).success
    ).toBe(false)
  })

  it('accepts a bounded privacy-safe Codex thread snapshot', () => {
    expect(
      codexThreadSyncRequestSchema.parse({
        snapshotId: 'b'.repeat(64),
        observedAt: '2026-08-06T00:00:00Z',
        observations: [
          {
            externalThreadId: 'thread-1',
            codexProjectId: 'project-1',
            classificationState: 'confirmed',
            authority: 'user_approved_plan',
            confidence: 1,
            evidenceDigest: 'c'.repeat(64)
          }
        ]
      })
    ).toMatchObject({ client: 'codex', source: 'codex_hook' })
  })

  it('keeps uncertain relation effects candidate unless confirmation is explicit', () => {
    const relation = {
      subject: { kind: 'project', name: 'A', canonicalUri: 'project://a' },
      relationType: 'DEPENDS_ON',
      target: { kind: 'service', name: 'B', canonicalUri: 'service://b' },
      operation: 'assert' as const,
      rationale: 'Observed during deterministic verification.'
    }
    const candidate = recordActivityRequestSchema.parse({
      ...activity,
      relationEffects: [relation]
    })
    const confirmed = recordActivityRequestSchema.parse({
      ...activity,
      relationEffects: [{ ...relation, confirmationState: 'confirmed' }]
    })
    expect(candidate.relationEffects[0]?.confirmationState).toBe('candidate')
    expect(confirmed.relationEffects[0]?.confirmationState).toBe('confirmed')
  })
})

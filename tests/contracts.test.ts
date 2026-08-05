import { describe, expect, it } from 'vitest'
import {
  agentClientObservationSchema,
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

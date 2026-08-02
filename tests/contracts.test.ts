import { describe, expect, it } from 'vitest'
import { manualCorrectionSchema, recordActivityRequestSchema } from '../src/core/contracts.js'

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

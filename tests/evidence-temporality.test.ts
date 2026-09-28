import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { Evidence } from '../src/core/contracts.js'
import { resolveContextRequestSchema } from '../src/core/contracts.js'
import {
  linkCurrentStateEvidence,
  markActivityObservation
} from '../src/core/evidence-temporality.js'
import { ContextResolver } from '../src/core/resolver.js'
import { PostgresOntologyRepository } from '../src/db/ontology-repository.js'

const sourceUri = 'https://github.com/example/project/pull/42'
const activityId = '00000000-0000-4000-8000-000000000001'
const asOf = '2026-08-04T16:09:00.000Z'
const raw: Evidence = {
  id: 'observation',
  layer: 'ontology',
  title: 'PR status',
  uri: sourceUri,
  excerpt: 'PR remains open and mergeable; maintainer re-review is required.',
  confidence: 1,
  authority: 1,
  projectId: 'project-a',
  updatedAt: '2026-09-28T00:00:00.000Z',
  metadata: { activityId }
}
const relation: Evidence = {
  ...raw,
  id: 'merged-relation',
  title: 'Current PR state',
  uri: 'boron://relation/merged',
  excerpt: 'GITHUB_PR_MERGED',
  metadata: {
    ontologyKind: 'relation',
    confirmationState: 'confirmed',
    relationType: 'GITHUB_PR_MERGED',
    stateFamily: 'github_pull_request',
    sourceUri,
    assertedByActivityId: activityId,
    relationAuthority: 'deterministic_source'
  }
}
const observed = (item: Evidence = raw, time: string | null = asOf) =>
  markActivityObservation(item, { activityId, asOf: time, subjectUri: sourceUri })

describe('evidence temporal interpretation', () => {
  it('preserves the complete activity text with its observation time, not evidence update time', () => {
    const item = observed()
    expect(item.excerpt).toContain(raw.excerpt)
    expect(item.excerpt).toContain(`as of ${asOf}; not proof of current state`)
    expect(item.excerpt).not.toContain(raw.updatedAt)
    expect(observed(raw, null).excerpt).toContain('as of unknown time')
  })

  it('corroborates only an exact source attached to the current state asserting activity', () => {
    const source = observed({
      ...raw,
      excerpt: 'MERGED',
      metadata: { activityId, sourceAuthority: 'deterministic_source' }
    })
    const [item] = linkCurrentStateEvidence([source], [relation])
    expect(item?.metadata.temporalContext).toMatchObject({
      role: 'current_state_source',
      currentStateRefs: [{ relationId: 'merged-relation' }]
    })
    const otherActivity = {
      ...relation,
      metadata: { ...relation.metadata, assertedByActivityId: 'other' }
    }
    const [unmatched] = linkCurrentStateEvidence([source], [otherActivity])
    expect(unmatched?.metadata.temporalContext).toMatchObject({ role: 'activity_observation' })
  })

  it('keeps conflicting current states ambiguous and cannot claim the source supports both', () => {
    const source = observed({ ...raw, metadata: { sourceAuthority: 'deterministic_source' } })
    const open = {
      ...relation,
      id: 'open-relation',
      metadata: {
        ...relation.metadata,
        relationType: 'GITHUB_PR_OPEN',
        assertedByActivityId: 'other'
      }
    }
    const [item] = linkCurrentStateEvidence([source], [relation, open])
    expect(item?.metadata.temporalContext).toMatchObject({ role: 'activity_observation' })
    expect(item?.excerpt).toContain('Current state is ambiguous')
    expect(item?.excerpt).not.toContain('supports the current')
  })

  it('does not let another state family borrow the same source endorsement', () => {
    const source = observed({ ...raw, metadata: { sourceAuthority: 'deterministic_source' } })
    const unrelated = {
      ...relation,
      id: 'other-state',
      metadata: {
        ...relation.metadata,
        relationType: 'BUILD_FAILED',
        stateFamily: 'build',
        assertedByActivityId: 'other'
      }
    }
    const [item] = linkCurrentStateEvidence([source], [relation, unrelated])
    expect(item?.excerpt).not.toContain('BUILD_FAILED')
    expect(item?.metadata.temporalContext).toMatchObject({
      role: 'current_state_source',
      currentStateRefs: [{ relationId: relation.id }]
    })
  })

  it('ignores untrusted stored relation metadata, other projects, unknown dates, and newer documents', () => {
    const source = observed({ ...raw, metadata: { sourceAuthority: 'deterministic_source' } })
    expect(linkCurrentStateEvidence([source, relation], [])[0]).toEqual(source)
    expect(
      linkCurrentStateEvidence([source], [{ ...relation, projectId: 'project-b' }])[0]
    ).toEqual(source)
    expect(
      linkCurrentStateEvidence(
        [observed({ ...raw, metadata: { sourceAuthority: 'deterministic_source' } }, null)],
        [relation]
      )[0]?.metadata.temporalContext
    ).toMatchObject({ role: 'activity_observation' })
    const document = { ...raw, id: 'new-doc', excerpt: 'A new design decision', metadata: {} }
    expect(linkCurrentStateEvidence([source, document], [])).toEqual([source, document])
  })

  it.each([
    'What is the current PR status?',
    '这个PR目前是否还是开启状态？',
    '核对当前事实，历史状态不能作为当前待办。',
    'Check current status. Do not treat historical status as current.'
  ])(
    'ranks current state above historical text even with an exact source anchor: %s',
    async (objective) => {
      const old = observed({ ...raw, id: 'old', metadata: {} })
      const current = observed({
        ...raw,
        id: 'new',
        contentHash: 'merged-state',
        excerpt: 'MERGED',
        metadata: { sourceAuthority: 'deterministic_source' }
      })
      const items = linkCurrentStateEvidence([old, current, relation], [relation])
      const resolver = new ContextResolver({
        projects: { resolve: async () => ({ id: 'project-a', name: 'Example', confidence: 1 }) },
        adapters: [
          {
            name: 'test',
            layer: 'ontology',
            sourceType: 'ontology',
            health: async () => ({ ok: true }),
            search: async () => items
          }
        ]
      })
      const request = {
        objective,
        objectHints: [sourceUri],
        layers: ['ontology'],
        tokenBudget: 6000
      }
      const capsule = await resolver.resolve(request)
      expect(capsule.evidence[0]?.id).toBe('new')
      expect(capsule.evidence.find((item) => item.id === 'old')?.excerpt).toContain(raw.excerpt)
      const history = await resolver.resolve({
        ...request,
        objective: 'Explain the historical PR status timeline.'
      })
      expect(history.evidence.find((item) => item.id === 'old')?.score).toBeGreaterThan(
        capsule.evidence.find((item) => item.id === 'old')!.score
      )
      expect(history.evidence.find((item) => item.id === 'old')?.excerpt).toContain(raw.excerpt)
    }
  )

  it.each([
    ['project-a', sourceUri],
    ['project-b', sourceUri],
    ['project-a', `boron://activity/${activityId}`],
    ['project-b', `boron://activity/${activityId}`]
  ])(
    'uses only same-project activity timestamps and synthetic URI fallbacks: %s, %s',
    async (activityProject, evidenceUri) => {
      const pool = {
        query: async (sql: string) => ({
          rows: sql.includes('FROM evidence')
            ? [
                {
                  id: 'stored',
                  layer: 'ontology',
                  title: raw.title,
                  uri: evidenceUri,
                  excerpt: raw.excerpt,
                  confidence: 1,
                  authority: 1,
                  updated_at: new Date(raw.updatedAt!),
                  content_hash: null,
                  project_id: 'project-a',
                  metadata: { activityId, temporalContext: { role: 'current_state_source' } }
                }
              ]
            : sql.includes('FROM activities')
              ? [
                  {
                    id: activityId,
                    occurred_at: new Date(asOf),
                    project_id: activityProject,
                    target_uri: 'codex://automation/example'
                  }
                ]
              : []
        })
      } as unknown as Pool
      const repository = new PostgresOntologyRepository(pool)
      const items = await repository.searchLayer('ontology', {
        request: resolveContextRequestSchema.parse({ objective: 'PR status' }),
        projectId: 'project-a',
        resolvedProjectName: 'Example',
        limit: 40,
        stageId: 'ontology-locate',
        purpose: 'locate',
        sourceAnchors: [sourceUri]
      })
      expect(items[0]?.metadata.temporalContext).toMatchObject({
        role: 'activity_observation',
        asOf: activityProject === 'project-a' ? asOf : null,
        subjectUri:
          activityProject === 'project-a' && evidenceUri.startsWith('boron://activity/')
            ? 'codex://automation/example'
            : evidenceUri
      })
    }
  )
})

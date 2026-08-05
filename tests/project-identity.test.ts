import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { ensureProject } from '../src/db/activity-repository.js'
import { selectResolvedProject } from '../src/db/project-identity.js'

describe('project identity resolution', () => {
  it('resolves a unique canonical identity', () => {
    expect(
      selectResolvedProject([{ id: 'context', name: 'Boron Context', priority: 1, peer_count: 1 }])
    ).toEqual({ id: 'context', name: 'Boron Context', confidence: 0.99 })
  })

  it('fails closed when the best identity tier has multiple owners', () => {
    expect(
      selectResolvedProject([
        { id: 'one', name: 'One', priority: 3, peer_count: 2 },
        { id: 'two', name: 'Two', priority: 3, peer_count: 2 }
      ])
    ).toBeNull()
  })

  it('does not resolve an unregistered project', () => {
    expect(selectResolvedProject([])).toBeNull()
  })

  it('does not create or rename a project from a broad home root', async () => {
    const queries: string[] = []
    const client = {
      query: async (sql: string) => {
        queries.push(sql)
        return { rows: [] }
      }
    } as never

    const project = await ensureProject(client, {
      objective: 'Verify broad root protection',
      projectHint: 'Unregistered Project',
      projectRoot: homedir(),
      client: 'test',
      constraints: [],
      tokenBudget: 512,
      metadata: {}
    })

    expect(project).toBeNull()
    expect(queries).toHaveLength(1)
    expect(queries.some((sql) => sql.includes('INSERT INTO projects'))).toBe(false)
  })

  it('uses an exact existing root without renaming it from a new hint', async () => {
    const queries: string[] = []
    const client = {
      query: async (sql: string) => {
        queries.push(sql)
        return queries.length === 1
          ? { rows: [] }
          : {
              rows: [
                {
                  id: 'existing-project',
                  name: 'Existing Project',
                  priority: 0,
                  peer_count: 1
                }
              ]
            }
      }
    } as never

    const project = await ensureProject(client, {
      objective: 'Verify exact root reuse',
      projectHint: 'Temporary Work Label',
      projectRoot: '/tmp/existing-project',
      client: 'test',
      constraints: [],
      tokenBudget: 512,
      metadata: {}
    })

    expect(project).toEqual({
      id: 'existing-project',
      name: 'Existing Project',
      confidence: 1
    })
    expect(queries.some((sql) => sql.includes('INSERT INTO projects'))).toBe(false)
    expect(queries.some((sql) => sql.includes('INSERT INTO project_aliases'))).toBe(false)
  })
})

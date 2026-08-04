import { describe, expect, it } from 'vitest'
import {
  discoverCodexProjects,
  planCodexRegistry,
  type CodexRegistry
} from '../src/db/project-registry.js'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

describe('Codex project registry discovery', () => {
  it('keeps exact existing roots and rejects a broad home root', async () => {
    const projects = await discoverCodexProjects(
      {
        'local-projects': {
          [firstId]: {
            id: firstId,
            name: 'IMBA Studio',
            rootPaths: ['/Users/example', '/Users/example/imba-studio']
          }
        },
        'project-order': [firstId]
      },
      {
        version: 1,
        authority: 'user_approved',
        provenance: 'test approval',
        projects: {},
        supersedeAliases: [],
        supersedeObjects: []
      },
      '/Users/example',
      async (path) => path === '/Users/example/imba-studio'
    )

    expect(projects).toHaveLength(1)
    expect(projects[0]?.roots).toEqual(['/Users/example/imba-studio'])
    expect(projects[0]?.ignoredRoots).toEqual([
      { path: '/Users/example', reason: 'broad_home_root' }
    ])
  })

  it('rejects canonical aliases assigned to two registered projects', async () => {
    await expect(
      discoverCodexProjects(
        {
          'local-projects': {
            [firstId]: { id: firstId, name: 'One', rootPaths: [] },
            [secondId]: { id: secondId, name: 'Two', rootPaths: [] }
          }
        },
        {
          version: 1,
          authority: 'user_approved',
          provenance: 'test approval',
          projects: {
            [firstId]: { aliases: ['Shared'] },
            [secondId]: { aliases: ['Shared'] }
          },
          supersedeAliases: [],
          supersedeObjects: []
        },
        '/Users/example',
        async () => false
      )
    ).rejects.toThrow('Canonical project identity collision')
  })

  it('adopts an exact authoritative root but leaves name-only matches as candidates', async () => {
    const registry: CodexRegistry = {
      provenance: 'test approval',
      authority: 'user_approved',
      stateUri: 'file:///tmp/codex-state.json',
      manifestUri: 'file:///tmp/manifest.json',
      supersedeAliases: [],
      supersedeObjects: [],
      standaloneIdentities: [],
      projects: [
        {
          codexProjectId: firstId,
          codexName: 'Content & Creations',
          canonicalName: 'Content & Creations',
          aliases: ['Content & Creations'],
          roots: ['/workspace/content'],
          ignoredRoots: [],
          replaceProjectSourceUri: false,
          removeLegacyLocalRoot: false
        }
      ]
    }
    const pool = {
      query: async () => ({
        rows: [
          {
            id: 'exact-root',
            name: 'Content workspace',
            source_uri: 'file:///workspace/content',
            status: 'confirmed',
            metadata: {},
            aliases: []
          },
          {
            id: 'name-only',
            name: 'Content & Creations',
            source_uri: 'file:///workspace/legacy',
            status: 'confirmed',
            metadata: {},
            aliases: []
          }
        ]
      })
    } as never

    const plan = await planCodexRegistry(pool, registry)

    expect(plan.projects[0]).toMatchObject({
      projectId: 'exact-root',
      matchReason: 'exact_root',
      roots: ['/workspace/content'],
      candidateProjects: [
        {
          id: 'name-only',
          name: 'Content & Creations',
          sourceUri: 'file:///workspace/legacy'
        }
      ]
    })
  })

  it('does not invent projects absent from authoritative Codex metadata', async () => {
    const projects = await discoverCodexProjects(
      {
        'local-projects': {
          [firstId]: { id: firstId, name: 'Registered', rootPaths: [] }
        }
      },
      {
        version: 1,
        authority: 'user_approved',
        provenance: 'test approval',
        projects: {},
        supersedeAliases: [],
        supersedeObjects: []
      },
      '/Users/example',
      async () => false
    )

    expect(projects.map((project) => project.canonicalName)).toEqual(['Registered'])
  })

  it('plans an auditable object supersession without deleting current relations', async () => {
    const registry: CodexRegistry = {
      provenance: 'test approval',
      authority: 'user_approved',
      stateUri: 'file:///tmp/codex-state.json',
      manifestUri: 'file:///tmp/manifest.json',
      projects: [],
      supersedeAliases: [],
      supersedeObjects: [
        {
          objectCanonicalUri: 'project://boron-content',
          supersededByObjectUri: 'file:///workspace/Boron-Context',
          reason: 'Canonical identity correction',
          closeCurrentRelations: true
        }
      ],
      standaloneIdentities: []
    }
    const pool = {
      query: async (sql: string, parameters?: readonly unknown[]) => {
        if (sql.includes('FROM projects p')) return { rows: [] }
        if (sql.includes('FROM relations')) return { rows: [{ count: '7' }] }
        const uri = parameters?.[0]
        if (uri === 'project://boron-content') {
          return {
            rows: [
              {
                id: 'legacy-object',
                name: 'Boron Content',
                canonical_uri: uri,
                confirmation_state: 'candidate'
              }
            ]
          }
        }
        if (uri === 'file:///workspace/Boron-Context') {
          return {
            rows: [
              {
                id: 'canonical-object',
                name: 'Boron Context',
                canonical_uri: uri,
                confirmation_state: 'confirmed'
              }
            ]
          }
        }
        return { rows: [] }
      }
    } as never

    const plan = await planCodexRegistry(pool, registry)

    expect(plan.supersedeObjects).toEqual([
      expect.objectContaining({
        objectId: 'legacy-object',
        supersededByObjectId: 'canonical-object',
        closeCurrentRelations: true,
        currentRelationCount: 7
      })
    ])
  })
})

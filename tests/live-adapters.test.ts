import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodebaseMemoryAdapter } from '../src/adapters/codebase-memory-adapter.js'
import { LocalWikiAdapter } from '../src/adapters/local-wiki-adapter.js'

describe('live context adapters', () => {
  it('queries the maintained Codebase Memory graph and measures the matched source file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-codebase-adapter-'))
    await mkdir(join(root, 'src'))
    await writeFile(
      join(root, 'src', 'resolver.ts'),
      'export function resolveContext() { return 1 }\n'
    )
    const request: typeof fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as {
        params: { name: string }
      }
      const payload =
        body.params.name === 'list_projects'
          ? { projects: [{ name: 'Users-example-Boron-Context', root_path: root }] }
          : {
              results: [
                {
                  name: 'resolveContext',
                  qualified_name: 'project.src.resolver.resolveContext',
                  label: 'Function',
                  file_path: 'src/resolver.ts',
                  start_line: 1
                }
              ]
            }
      return new Response(
        JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    const adapter = new CodebaseMemoryAdapter('http://127.0.0.1:9749', 5_000, request)
    const evidence = await adapter.search({
      request: {
        objective: 'Inspect resolver code',
        projectHint: 'Boron Content',
        objectHints: [],
        constraints: [],
        tokenBudget: 512,
        client: 'test',
        workflow: 'read'
      },
      projectId: 'project-1',
      resolvedProjectName: 'Boron Context',
      limit: 10,
      stageId: 'codebase-source',
      purpose: 'code',
      sourceAnchors: []
    })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      layer: 'codebase',
      metadata: { filePath: 'src/resolver.ts', sourceTokenEstimate: expect.any(Number) }
    })
  })

  it('searches OpenWiki Markdown live and records real source coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-wiki-adapter-'))
    await writeFile(
      join(root, 'continuity.md'),
      '# Boron Context continuity\n\nBoron Context resumes verified project decisions across agent sessions.\n'
    )
    await writeFile(
      join(root, 'machina.md'),
      '# Machina continuity\n\nMachina resumes verified project decisions across agent sessions.\n'
    )
    const adapter = new LocalWikiAdapter(root)
    const evidence = await adapter.search({
      request: {
        objective: 'Resume Boron continuity decisions',
        projectHint: 'Boron Context',
        objectHints: [],
        constraints: [],
        tokenBudget: 512,
        client: 'test',
        workflow: 'session_start'
      },
      projectId: 'project-1',
      resolvedProjectName: 'Boron Context',
      limit: 10,
      stageId: 'wiki-continuity',
      purpose: 'continuity',
      sourceAnchors: []
    })
    expect(evidence[0]).toMatchObject({
      title: 'Boron Context continuity',
      metadata: { sourceTokenEstimate: expect.any(Number) }
    })
    expect(evidence).toHaveLength(1)
  })
})

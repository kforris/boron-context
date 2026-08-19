import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodebaseMemoryAdapter } from '../src/adapters/codebase-memory-adapter.js'
import { LocalWikiAdapter } from '../src/adapters/local-wiki-adapter.js'
import { ProjectMarkdownAdapter } from '../src/adapters/project-markdown-adapter.js'

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

  it('searches Markdown inside confirmed project roots without requiring repeated project branding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-project-markdown-'))
    await mkdir(join(root, 'docs', 'architecture'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'noise'), { recursive: true })
    await writeFile(
      join(root, 'docs', 'architecture', 'product-roadmap.md'),
      '# Product roadmap\n\nThe 0.8 lifecycle covers install, upgrade, uninstall, and rollback.\n'
    )
    await writeFile(
      join(root, 'node_modules', 'noise', 'roadmap.md'),
      '# Dependency roadmap\n\nThis file must not enter project context.\n'
    )
    const adapter = new ProjectMarkdownAdapter(async (projectId) =>
      projectId === 'project-1' ? [root] : []
    )
    const evidence = await adapter.search({
      request: {
        objective: '检查项目路线图和愿景',
        projectHint: 'Boron Context',
        objectHints: [],
        constraints: ['read-only'],
        tokenBudget: 512,
        client: 'test',
        workflow: 'read'
      },
      projectId: 'project-1',
      resolvedProjectName: 'Boron Context',
      limit: 10,
      stageId: 'wiki-knowledge',
      purpose: 'knowledge',
      sourceAnchors: []
    })

    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      title: 'Product roadmap',
      metadata: {
        path: 'docs/architecture/product-roadmap.md',
        sourceKind: 'registered_project_root',
        sourceTokenEstimate: expect.any(Number),
        sourceSize: { basis: 'local_file_bytes_divided_by_4' }
      }
    })
  })

  it('prioritizes an exact Markdown source anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-project-anchor-'))
    await writeFile(join(root, 'README.md'), '# Overview\n\nGeneral project information.\n')
    await writeFile(join(root, 'ROADMAP.md'), '# Roadmap\n\nLifecycle milestones.\n')
    const adapter = new ProjectMarkdownAdapter(async () => [root])
    const roadmapPath = join(root, 'ROADMAP.md')
    const evidence = await adapter.search({
      request: {
        objective: 'Inspect project information',
        projectHint: 'Boron Context',
        objectHints: [roadmapPath],
        constraints: [],
        tokenBudget: 512,
        client: 'test',
        workflow: 'read'
      },
      projectId: 'project-1',
      resolvedProjectName: 'Boron Context',
      limit: 10,
      stageId: 'wiki-knowledge',
      purpose: 'knowledge',
      sourceAnchors: [roadmapPath]
    })

    expect(evidence[0]?.title).toBe('Roadmap')
  })

  it('keeps generic operational ledgers behind the requested document type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-project-document-intent-'))
    await mkdir(join(root, 'docs', 'architecture'), { recursive: true })
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(
      join(root, 'docs', 'architecture', 'product-roadmap.md'),
      '# Product roadmap\n\nThe 0.8 macOS lifecycle goals cover install, upgrade, uninstall, backup, restore, and rollback.\n'
    )
    await writeFile(
      join(root, 'CHANGELOG.md'),
      '# Changelog\n\nThe 0.8 macOS lifecycle added install, upgrade, uninstall, backup, restore, and rollback.\n'
    )
    await writeFile(
      join(root, 'README.md'),
      '# Boron Context\n\nPrivacy: Boron does not store raw transcripts, patch private Codex state, or copy prompts.\n'
    )
    await writeFile(
      join(root, 'docs', 'release-checklist.md'),
      '# Release checklist\n\nVerify privacy, raw transcripts, private Codex state, prompts, storage, and patches.\n'
    )
    const adapter = new ProjectMarkdownAdapter(async () => [root])
    const search = (objective: string) =>
      adapter.search({
        request: {
          objective,
          projectHint: 'Boron Context',
          objectHints: [],
          constraints: [],
          tokenBudget: 512,
          client: 'test',
          workflow: 'read'
        },
        projectId: 'project-1',
        resolvedProjectName: 'Boron Context',
        limit: 10,
        stageId: 'wiki-knowledge',
        purpose: 'knowledge',
        sourceAnchors: []
      })

    const lifecycle = await search(
      'Explain the 0.8 macOS lifecycle goals for install, upgrade, uninstall, backup, and restore.'
    )
    expect(lifecycle[0]?.metadata.path).toBe('docs/architecture/product-roadmap.md')
    const privacy = await search(
      'Explain why Boron does not store raw transcripts or patch private Codex state.'
    )
    expect(privacy[0]?.metadata.path).toBe('README.md')
  })
})

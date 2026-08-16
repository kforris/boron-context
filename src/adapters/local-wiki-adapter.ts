import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AdapterSearchInput, ContextAdapter } from '../core/context-adapter.js'
import type { Evidence } from '../core/contracts.js'

const MAX_FILES = 200
const MAX_DIRECTORIES = 200
const MAX_FILE_BYTES = 256 * 1024

export class LocalWikiAdapter implements ContextAdapter {
  readonly layer = 'wiki' as const
  readonly name = 'OpenWiki live Markdown'
  readonly sourceType = 'live' as const

  constructor(private readonly root: string) {}

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      const info = await stat(this.root)
      return info.isDirectory()
        ? { ok: true }
        : { ok: false, detail: 'OpenWiki root is not a directory' }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(input: AdapterSearchInput): Promise<readonly Evidence[]> {
    const root = await realpath(this.root)
    const files = await markdownFiles(root)
    const terms = queryTerms(input.request.objective)
    const candidates: { score: number; evidence: Evidence }[] = []
    for (const path of files) {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      const content = await readFile(path, 'utf8')
      const localPath = relative(root, path)
      const title = markdownTitle(content) ?? basename(path, '.md')
      const searchable = `${title}\n${localPath}\n${content}`
      if (
        input.resolvedProjectName &&
        !containsProjectIdentity(searchable, input.resolvedProjectName)
      )
        continue
      const score = relevance(terms, searchable)
      if (terms.size > 0 && score === 0) continue
      const excerpt = boundedExcerpt(content, terms)
      candidates.push({
        score,
        evidence: {
          id: createHash('sha256').update(path).digest('hex'),
          layer: 'wiki',
          title,
          uri: pathToFileURL(path).href,
          excerpt,
          confidence: 0.9,
          authority: 0.9,
          updatedAt: info.mtime.toISOString(),
          contentHash: createHash('sha256').update(content).digest('hex'),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          metadata: {
            path: localPath,
            sourceTokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
            sourceSize: {
              status: 'measured',
              tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
              basis: 'utf16_characters_divided_by_4'
            }
          }
        }
      })
    }
    return candidates
      .sort(
        (left, right) =>
          right.score - left.score || left.evidence.title.localeCompare(right.evidence.title)
      )
      .slice(0, input.limit)
      .map((candidate) => candidate.evidence)
  }
}

async function markdownFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  const pending = [root]
  let visitedDirectories = 0
  while (pending.length > 0 && files.length < MAX_FILES && visitedDirectories < MAX_DIRECTORIES) {
    const directory = pending.shift()!
    visitedDirectories += 1
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (relative(root, path).startsWith('..')) continue
      if (entry.isDirectory() && pending.length + visitedDirectories < MAX_DIRECTORIES)
        pending.push(path)
      else if (entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.md'))
        files.push(path)
      if (files.length >= MAX_FILES) break
    }
  }
  return files
}

function containsProjectIdentity(value: string, projectName: string): boolean {
  const text = value.toLocaleLowerCase('en-US')
  const projectTerms = queryTerms(projectName)
  return projectTerms.size > 0 && [...projectTerms].every((term) => text.includes(term))
}

function queryTerms(value: string): ReadonlySet<string> {
  return new Set(
    value
      .toLocaleLowerCase('en-US')
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length > 1)
  )
}

function relevance(terms: ReadonlySet<string>, value: string): number {
  if (terms.size === 0) return 0.5
  const text = value.toLocaleLowerCase('en-US')
  let matches = 0
  for (const term of terms) if (text.includes(term)) matches += 1
  return matches / terms.size
}

function markdownTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim() || null
}

function boundedExcerpt(content: string, terms: ReadonlySet<string>): string {
  const lower = content.toLocaleLowerCase('en-US')
  let index = 0
  for (const term of terms) {
    const candidate = lower.indexOf(term)
    if (candidate >= 0) {
      index = candidate
      break
    }
  }
  const start = Math.max(0, index - 300)
  const excerpt = content.slice(start, start + 1_600).trim()
  return excerpt || '(Empty Markdown page)'
}

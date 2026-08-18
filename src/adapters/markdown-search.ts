import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AdapterSearchInput } from '../core/context-adapter.js'
import type { Evidence } from '../core/contracts.js'

const MAX_FILES = 200
const MAX_DIRECTORIES = 200
const MAX_FILE_BYTES = 256 * 1024
const EXCLUDED_DIRECTORIES = new Set([
  '.build',
  '.codex',
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor'
])

const TERM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  愿景: ['vision', 'goal', 'direction'],
  目标: ['goal', 'vision', 'roadmap'],
  路线图: ['roadmap', 'direction', 'milestone'],
  健康: ['health', 'quality', 'status'],
  发布: ['release', 'publish'],
  安装: ['install', 'setup'],
  升级: ['upgrade', 'migration'],
  恢复: ['recovery', 'restore', 'rollback'],
  安全: ['security', 'trust'],
  隐私: ['privacy', 'transcript'],
  上下文: ['context', 'continuity'],
  评测: ['evaluation', 'recall', 'baseline']
}

export interface MarkdownSource {
  readonly root: string
  readonly sourceKind: 'openwiki' | 'registered_project_root'
  readonly requireProjectIdentity: boolean
}

interface MarkdownCandidate {
  readonly score: number
  readonly evidence: Evidence
}

export async function searchMarkdownSources(
  sources: readonly MarkdownSource[],
  input: AdapterSearchInput
): Promise<readonly Evidence[]> {
  const terms = queryTerms(
    [
      input.request.objective,
      ...input.request.objectHints,
      ...input.request.constraints,
      ...input.sourceAnchors
    ].join(' ')
  )
  if (input.resolvedProjectName) {
    for (const identityTerm of queryTerms(input.resolvedProjectName)) terms.delete(identityTerm)
  }
  const candidates: MarkdownCandidate[] = []
  const visitedFiles = new Set<string>()
  let remainingFiles = MAX_FILES

  for (const source of sources) {
    if (remainingFiles <= 0) break
    let root: string
    try {
      root = await realpath(source.root)
      if (!(await stat(root)).isDirectory()) continue
    } catch {
      continue
    }
    const files = await markdownFiles(root, remainingFiles)
    remainingFiles -= files.length
    for (const path of files) {
      let canonicalPath: string
      try {
        canonicalPath = await realpath(path)
      } catch {
        continue
      }
      if (visitedFiles.has(canonicalPath)) continue
      visitedFiles.add(canonicalPath)
      const info = await stat(canonicalPath)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      const content = await readFile(canonicalPath, 'utf8')
      const localPath = relative(root, canonicalPath)
      const title = markdownTitle(content) ?? basename(canonicalPath, '.md')
      const searchable = `${title}\n${localPath}\n${content}`
      if (
        source.requireProjectIdentity &&
        input.resolvedProjectName &&
        !containsProjectIdentity(searchable, input.resolvedProjectName)
      )
        continue
      const lexicalScore = relevance(terms, searchable)
      const uri = pathToFileURL(canonicalPath).href
      const anchorScore = sourceAnchorRelevance(input.sourceAnchors, uri, localPath, title)
      if (terms.size > 0 && lexicalScore === 0 && anchorScore === 0) continue
      const sourceTokenEstimate = Math.max(1, Math.ceil(info.size / 4))
      candidates.push({
        score: lexicalScore * 0.7 + anchorScore * 0.3,
        evidence: {
          id: createHash('sha256').update(canonicalPath).digest('hex'),
          layer: 'wiki',
          title,
          uri,
          excerpt: boundedExcerpt(content, terms),
          confidence: 0.95,
          authority: source.sourceKind === 'registered_project_root' ? 0.95 : 0.9,
          updatedAt: info.mtime.toISOString(),
          contentHash: createHash('sha256').update(content).digest('hex'),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          metadata: {
            path: localPath,
            sourceKind: source.sourceKind,
            adapterRelevance: lexicalScore * 0.7 + anchorScore * 0.3,
            sourceTokenEstimate,
            sourceSize: {
              status: 'measured',
              tokenEstimate: sourceTokenEstimate,
              sourceBytes: info.size,
              basis: 'local_file_bytes_divided_by_4'
            }
          }
        }
      })
    }
  }

  return candidates
    .sort(
      (left, right) =>
        right.score - left.score || left.evidence.uri.localeCompare(right.evidence.uri)
    )
    .slice(0, input.limit)
    .map((candidate) => candidate.evidence)
}

async function markdownFiles(root: string, limit: number): Promise<readonly string[]> {
  const files: string[] = []
  const pending = [root]
  let visitedDirectories = 0
  while (pending.length > 0 && files.length < limit && visitedDirectories < MAX_DIRECTORIES) {
    const directory = pending.shift()!
    visitedDirectories += 1
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    )
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (relative(root, path).startsWith('..')) continue
      if (
        entry.isDirectory() &&
        !EXCLUDED_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US')) &&
        pending.length + visitedDirectories < MAX_DIRECTORIES
      )
        pending.push(path)
      else if (entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.md'))
        files.push(path)
      if (files.length >= limit) break
    }
  }
  return files
}

function containsProjectIdentity(value: string, projectName: string): boolean {
  const text = value.toLocaleLowerCase('en-US')
  const projectTerms = projectName
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1)
  return projectTerms.length > 0 && projectTerms.every((term) => text.includes(term))
}

function queryTerms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase('en-US')
  const terms = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1)
  const expanded = new Set(terms.filter((term) => !QUERY_STOP_WORDS.has(term)))
  for (const [term, aliases] of Object.entries(TERM_ALIASES)) {
    if (!normalized.includes(term)) continue
    expanded.add(term)
    for (const alias of aliases) expanded.add(alias)
  }
  return expanded
}

function relevance(terms: ReadonlySet<string>, value: string): number {
  if (terms.size === 0) return 0.5
  const text = value.toLocaleLowerCase('en-US')
  let matches = 0
  for (const term of terms) if (text.includes(term)) matches += 1
  return matches / Math.min(terms.size, 12)
}

function sourceAnchorRelevance(
  anchors: readonly string[],
  uri: string,
  localPath: string,
  title: string
): number {
  const values = [uri, localPath, title].map((value) => value.toLocaleLowerCase('en-US'))
  for (const anchor of anchors) {
    const normalized = anchor.toLocaleLowerCase('en-US').replace(/^file:\/\//, '')
    if (values.some((value) => value === normalized || value.endsWith(normalized))) return 1
    if (values.some((value) => value.includes(normalized) || normalized.includes(value))) return 0.9
  }
  return 0
}

function markdownTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim() || null
}

function boundedExcerpt(content: string, terms: ReadonlySet<string>): string {
  const lower = content.toLocaleLowerCase('en-US')
  let bestIndex = 0
  let bestMatches = -1
  for (const term of terms) {
    let candidate = lower.indexOf(term)
    let occurrences = 0
    while (candidate >= 0 && occurrences < 5) {
      const start = Math.max(0, candidate - 300)
      const window = lower.slice(start, start + 1_600)
      let matches = 0
      for (const queryTerm of terms) if (window.includes(queryTerm)) matches += 1
      if (matches > bestMatches) {
        bestIndex = candidate
        bestMatches = matches
      }
      candidate = lower.indexOf(term, candidate + term.length)
      occurrences += 1
    }
  }
  const start = Math.max(0, bestIndex - 300)
  const excerpt = content.slice(start, start + 1_600).trim()
  return excerpt || '(Empty Markdown page)'
}

const QUERY_STOP_WORDS = new Set([
  'about',
  'after',
  'and',
  'anything',
  'are',
  'before',
  'can',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'into',
  'its',
  'not',
  'only',
  'our',
  'the',
  'project',
  'should',
  'that',
  'their',
  'then',
  'there',
  'these',
  'this',
  'those',
  'what',
  'where',
  'which',
  'with',
  'without',
  'would'
])

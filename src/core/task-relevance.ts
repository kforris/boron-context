import type { Evidence, ResolveContextRequest } from './contracts.js'

// Concepts are deliberately small, inspectable, and independent of project names.
// Matching a bilingual concept once avoids inflating relevance with synonym counts.
const CONCEPTS = [
  /\b(?:vision|purpose|mission|goals?|roadmap|direction)\b|愿景|目标|路线图|方向|宗旨/iu,
  /\b(?:architecture|design|methodology|rationale|decisions?)\b|架构|设计|方法论|理由|决策/iu,
  /\b(?:progress|status|blockers?|remaining|next steps?)\b|进度|状态|阻塞|剩余|下一步/iu,
  /\b(?:audits?|health|readiness|gates?|checklists?)\b|审计|健康|准备度|检查清单|门禁/iu
] as const

const STOP_WORDS = new Set(
  'about after and anything are before can does for from has have how into its not only our the project should that their then there these this those what where which with without would is was we you it do did'.split(
    ' '
  )
)

export interface TaskRelevance {
  readonly strategy: boolean
  relevance(evidence: Evidence): number
  noisePenalty(evidence: Evidence): number
  historicalStatePenalty(evidence: Evidence): number
}

export function analyzeTaskRelevance(
  request: ResolveContextRequest,
  projectName?: string
): TaskRelevance {
  // Constraints determine authorization and filtering elsewhere, not the topic.
  const query = [request.objective, ...request.objectHints].join(' ')
  const concepts = CONCEPTS.filter((pattern) => pattern.test(query))
  const strategy = CONCEPTS[0].test(query)
  const auditRequested = CONCEPTS[3].test(query)
  const historyExcluded =
    /历史状态(?:不能|不应|不可)作为当前|(?:不要|不把|排除)[^。；]{0,12}历史|\b(?:do not|don't|never) (?:use|treat) historical (?:state|status) as current\b/iu.test(
      query
    )
  const currentStateRequested =
    /\b(?:current|currently|status|state|still|now)\b|当前|目前|现在|状态|是否仍|是否还/iu.test(
      query
    ) &&
    (historyExcluded ||
      !/\b(?:history|historical|previous|before|past|timeline|as of)\b|历史|当时|曾经|过去|复盘|之前|截至|那时/iu.test(
        query
      ))
  let topicalQuery = query.toLocaleLowerCase('en-US')
  for (const identity of [projectName, request.projectHint]) {
    if (identity) topicalQuery = topicalQuery.replaceAll(identity.toLocaleLowerCase('en-US'), ' ')
  }
  const terms = new Set(
    topicalQuery
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
  )

  return {
    strategy,
    relevance(evidence) {
      const text = `${evidence.title} ${evidence.excerpt}`.toLocaleLowerCase('en-US')
      let matches = 0
      for (const term of terms) if (text.includes(term)) matches += 1
      const lexical = terms.size === 0 ? 0.5 : Math.min(1, matches / Math.min(terms.size, 8))
      const matchedConcepts = concepts.filter((pattern) => pattern.test(text)).length
      const conceptual =
        !strategy || concepts.length === 0 ? 0 : (matchedConcepts / concepts.length) * 0.75
      return Math.max(lexical, conceptual)
    },
    historicalStatePenalty(evidence) {
      const temporal = evidence.metadata.temporalContext as
        { role?: string; currentStateRefs?: unknown[] } | undefined
      if (
        currentStateRequested &&
        temporal?.role === 'activity_observation' &&
        Array.isArray(temporal.currentStateRefs) &&
        temporal.currentStateRefs.length > 0
      )
        return 0.25
      return 0
    },
    noisePenalty(evidence) {
      // Operational audits remain searchable and win for explicit audit requests.
      // Only strategic questions demote routine audit records; substantive decisions
      // and policy evidence are not classified as noise by their activity origin.
      if (!strategy || auditRequested || evidence.metadata.ontologyKind === 'policy') return 0
      const identity = `${evidence.title} ${String(evidence.metadata.path ?? '')}`
      return /(?:audit[_. -]completed|release[_. -]candidate[_. -]audit|health[_. -]check|RC\s+(?:audit|审计)|健康检查|发布审计)/iu.test(
        identity
      )
        ? 0.24
        : 0
    }
  }
}

export function extractSourceAnchors(text: string, objectHints: readonly string[]): string[] {
  const anchors: string[] = []
  // Separators in ordinary prose (跨任务/跨Agent, B2B/B2C) are not path starts.
  // Explicit paths/URLs must begin at a token boundary; relative file names must
  // have a recognizable extension. Object hints use the same rules as prose.
  const tokens = text.split(/[\s"'`<>，。；！？、（）\[\]{}]+/u)
  for (const raw of [...tokens, ...objectHints]) {
    const value = raw
      .replace(/^[(:]+/, '')
      .replace(/[,.;:]+$/, '')
      .replace(/(?<!\()\)$/, '')
    if (!value || /\s/u.test(value)) continue
    if (
      /^(?:file:\/\/\/|[a-z][a-z0-9+.-]*:\/\/|\.\.?\/|~\/|\/)[^/\s].*/i.test(value) ||
      /^(?:[\p{L}\p{N}_.@-]+\/)*[\p{L}\p{N}_.@-]+\.(?:md|mdx|txt|rst|[cm]?[jt]sx?|py|go|rs|swift|java|kt|rb|php|sql|toml|ya?ml|json|html|css|sh)(?:[:#?][^\s]*)?$/iu.test(
        value
      ) ||
      /^[\w.]+(?:::\w+)+$|^\w+(?:\.\w+)*\(\)$/u.test(value)
    )
      anchors.push(value)
  }
  return [...new Set(anchors)].slice(0, 50)
}

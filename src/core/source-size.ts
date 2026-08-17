import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActivityEvidenceInput } from './contracts.js'

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])

export async function instrumentActivityEvidenceSourceSize(
  input: ActivityEvidenceInput,
  registeredProjectRoots: readonly string[] = []
): Promise<ActivityEvidenceInput> {
  if (input.sourceTokenEstimate) {
    return withSourceSize(input, {
      status: 'measured',
      tokenEstimate: input.sourceTokenEstimate,
      basis: 'client_reported_token_estimate'
    })
  }
  if (!input.uri) return input

  let uri: URL
  try {
    uri = new URL(input.uri)
  } catch {
    return input
  }

  if (uri.protocol !== 'file:') {
    if (isRemoteSourceProtocol(uri.protocol)) {
      return withSourceSize(input, {
        status: 'unavailable',
        reason: 'remote_source_not_fetched'
      })
    }
    return input
  }

  let path: string
  try {
    path = fileURLToPath(uri)
  } catch {
    return withSourceSize(input, {
      status: 'unavailable',
      reason: 'non_local_file_uri'
    })
  }

  const registeredRoot = registeredProjectRoots.find((root) => isWithin(root, path))
  if (!registeredRoot) {
    return withSourceSize(input, {
      status: 'unavailable',
      reason:
        registeredProjectRoots.length === 0
          ? 'registered_project_root_unavailable'
          : 'outside_registered_project_root'
    })
  }

  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(registeredRoot),
      realpath(path)
    ])
    if (!isWithin(canonicalRoot, canonicalPath)) {
      return withSourceSize(input, {
        status: 'unavailable',
        reason: 'outside_registered_project_root'
      })
    }
    const info = await stat(canonicalPath)
    if (info.isDirectory()) {
      return withSourceSize(input, {
        status: 'not_applicable',
        reason: 'local_directory_reference'
      })
    }
    if (!info.isFile()) {
      return withSourceSize(input, {
        status: 'unavailable',
        reason: 'unsupported_local_path_type'
      })
    }
    if (!TEXT_EXTENSIONS.has(extname(path).toLocaleLowerCase('en-US'))) {
      return withSourceSize(input, {
        status: 'unavailable',
        reason: 'unsupported_local_file_type'
      })
    }
    const sourceTokenEstimate = Math.max(1, Math.ceil(info.size / 4))
    return withSourceSize(
      { ...input, sourceTokenEstimate },
      {
        status: 'measured',
        tokenEstimate: sourceTokenEstimate,
        sourceBytes: info.size,
        basis: 'local_file_bytes_divided_by_4'
      }
    )
  } catch (error) {
    const code = nodeErrorCode(error)
    return withSourceSize(input, {
      status: 'unavailable',
      reason:
        code === 'ENOENT'
          ? 'local_file_not_found'
          : code === 'EACCES' || code === 'EPERM'
            ? 'local_file_inaccessible'
            : 'local_file_unavailable'
    })
  }
}

function isWithin(root: string, path: string): boolean {
  const offset = relative(resolve(root), resolve(path))
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function withSourceSize(
  input: ActivityEvidenceInput,
  sourceSize: Readonly<Record<string, unknown>>
): ActivityEvidenceInput {
  return { ...input, metadata: { ...input.metadata, sourceSize } }
}

function isRemoteSourceProtocol(protocol: string): boolean {
  return ['http:', 'https:', 'github:', 'gitlab:', 'bitbucket:'].includes(
    protocol.toLocaleLowerCase('en-US')
  )
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

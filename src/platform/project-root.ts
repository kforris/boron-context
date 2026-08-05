import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DiscoveredProjectRoot {
  readonly root: string
  readonly repositoryRoot?: string
  readonly repositoryUri?: string
}

export async function discoverProjectRoot(root: string): Promise<DiscoveredProjectRoot> {
  const canonicalRoot = await realpath(root).catch(() => root)
  try {
    const [{ stdout: repositoryRootOutput }, { stdout: remoteOutput }] = await Promise.all([
      execFileAsync('git', ['-C', canonicalRoot, 'rev-parse', '--show-toplevel'], {
        timeout: 2_000,
        maxBuffer: 64 * 1024
      }),
      execFileAsync('git', ['-C', canonicalRoot, 'config', '--get', 'remote.origin.url'], {
        timeout: 2_000,
        maxBuffer: 64 * 1024
      })
    ])
    const repositoryRoot = await realpath(repositoryRootOutput.trim()).catch(() =>
      repositoryRootOutput.trim()
    )
    const repositoryUri = normalizeRepositoryUri(remoteOutput.trim())
    return {
      root: canonicalRoot,
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(repositoryUri ? { repositoryUri } : {})
    }
  } catch {
    return { root: canonicalRoot }
  }
}

export function normalizeRepositoryUri(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!trimmed) return null
  const scp = trimmed.match(/^git@([^:]+):(.+)$/)
  if (scp) return repositoryUri(scp[1]!, scp[2]!)
  try {
    const url = new URL(trimmed)
    url.username = ''
    url.password = ''
    if (url.protocol === 'ssh:' || url.protocol === 'git:' || url.protocol === 'https:') {
      return repositoryUri(url.hostname, url.pathname)
    }
  } catch {
    return null
  }
  return null
}

function repositoryUri(host: string, path: string): string {
  const cleanHost = host.toLocaleLowerCase('en-US')
  const cleanPath = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  return cleanHost === 'github.com' ? `github://${cleanPath}` : `git://${cleanHost}/${cleanPath}`
}

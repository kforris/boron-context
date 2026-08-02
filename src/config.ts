import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { platformPaths } from './platform/paths.js'

const portSchema = z.coerce.number().int().min(1).max(65_535)

export interface BoronConfig {
  readonly host: string
  readonly port: number
  readonly tokenPath: string
  readonly openWikiRoot: string
  readonly codebaseMemoryGraphUrl: string
  readonly codebaseMemoryCommand: string
  readonly codebaseMemoryUrl?: string
  readonly openWikiUrl?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BoronConfig {
  const paths = platformPaths(process.platform, env)
  return {
    host: env.BORON_HOST ?? '127.0.0.1',
    port: portSchema.parse(env.BORON_PORT ?? '41635'),
    tokenPath: paths.tokenPath,
    openWikiRoot: env.BORON_OPENWIKI_ROOT ?? join(homedir(), '.openwiki', 'wiki'),
    codebaseMemoryGraphUrl: localInspectorSource(
      env.BORON_CODEBASE_MEMORY_GRAPH_URL ?? 'http://127.0.0.1:9749'
    ),
    codebaseMemoryCommand:
      env.BORON_CODEBASE_MEMORY_COMMAND ?? join(homedir(), '.local', 'bin', 'codebase-memory-mcp'),
    ...(env.BORON_CODEBASE_MEMORY_URL ? { codebaseMemoryUrl: env.BORON_CODEBASE_MEMORY_URL } : {}),
    ...(env.BORON_OPENWIKI_URL ? { openWikiUrl: env.BORON_OPENWIKI_URL } : {})
  }
}

function localInspectorSource(value: string): string {
  const url = new URL(value)
  const loopback = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
  if (!['http:', 'https:'].includes(url.protocol) || !loopback.has(url.hostname)) {
    throw new Error('BORON_CODEBASE_MEMORY_GRAPH_URL must be a loopback HTTP(S) URL')
  }
  if (url.username || url.password) {
    throw new Error('BORON_CODEBASE_MEMORY_GRAPH_URL must not contain credentials')
  }
  return url.toString().replace(/\/$/, '')
}

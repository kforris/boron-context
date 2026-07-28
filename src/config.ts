import { z } from 'zod'
import { platformPaths } from './platform/paths.js'

const portSchema = z.coerce.number().int().min(1).max(65_535)

export interface BoronConfig {
  readonly host: string
  readonly port: number
  readonly tokenPath: string
  readonly codebaseMemoryUrl?: string
  readonly openWikiUrl?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BoronConfig {
  const paths = platformPaths(process.platform, env)
  return {
    host: env.BORON_HOST ?? '127.0.0.1',
    port: portSchema.parse(env.BORON_PORT ?? '41634'),
    tokenPath: paths.tokenPath,
    ...(env.BORON_CODEBASE_MEMORY_URL ? { codebaseMemoryUrl: env.BORON_CODEBASE_MEMORY_URL } : {}),
    ...(env.BORON_OPENWIKI_URL ? { openWikiUrl: env.BORON_OPENWIKI_URL } : {})
  }
}

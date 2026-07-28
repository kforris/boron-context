import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HttpContextAdapter } from './adapters/http-adapter.js'
import { ContextResolver } from './core/resolver.js'
import { loadConfig } from './config.js'
import { migrateDatabase } from './db/migrate.js'
import { PostgresOntologyRepository } from './db/ontology-repository.js'
import { createPool, loadDatabaseConfig } from './db/pool.js'
import { startGateway, type RunningGateway } from './gateway/server.js'
import { loadOrCreateToken } from './platform/token.js'

export async function startRuntime(env: NodeJS.ProcessEnv = process.env): Promise<{
  readonly gateway: RunningGateway
  close(): Promise<void>
}> {
  const config = loadConfig(env)
  const pool = createPool(loadDatabaseConfig(env))
  const ontology = new PostgresOntologyRepository(pool)
  const adapters = [
    ontology,
    ...(config.codebaseMemoryUrl
      ? [
          new HttpContextAdapter({
            layer: 'codebase',
            name: 'Codebase Memory',
            baseUrl: config.codebaseMemoryUrl,
            ...(env.BORON_CODEBASE_MEMORY_TOKEN ? { token: env.BORON_CODEBASE_MEMORY_TOKEN } : {})
          })
        ]
      : []),
    ...(config.openWikiUrl
      ? [
          new HttpContextAdapter({
            layer: 'wiki',
            name: 'OpenWiki',
            baseUrl: config.openWikiUrl,
            ...(env.BORON_OPENWIKI_TOKEN ? { token: env.BORON_OPENWIKI_TOKEN } : {})
          })
        ]
      : [])
  ]
  const resolver = new ContextResolver({ adapters, projects: ontology })
  const token = env.BORON_DAEMON_TOKEN ?? (await loadOrCreateToken(config.tokenPath))
  const gateway = await startGateway({
    host: config.host,
    port: config.port,
    token,
    resolver,
    adapters,
    databaseHealth: () => ontology.health(),
    version: await packageVersion()
  })
  return {
    gateway,
    close: async () => {
      await gateway.close()
      await pool.end()
    }
  }
}

export async function migrateRuntimeDatabase(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pool = createPool(loadDatabaseConfig(env))
  try {
    await migrateDatabase(pool)
  } finally {
    await pool.end()
  }
}

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(resolve(process.cwd(), 'package.json'), 'utf8')
  ) as { version?: unknown }
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
}

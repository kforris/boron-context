import { Pool, type PoolConfig } from 'pg'

export interface DatabaseConfig {
  readonly connectionString: string
  readonly applicationName: string
  readonly maxConnections: number
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return {
    connectionString: env.BORON_DATABASE_URL ?? 'postgresql://127.0.0.1/boron_context',
    applicationName: env.BORON_DB_APPLICATION_NAME ?? 'boron-context-daemon',
    maxConnections: positiveInteger(env.BORON_DB_POOL_SIZE, 10, 'BORON_DB_POOL_SIZE')
  }
}

export function createPool(config: DatabaseConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    application_name: config.applicationName,
    max: config.maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: false
  }
  return new Pool(poolConfig)
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`)
  return parsed
}

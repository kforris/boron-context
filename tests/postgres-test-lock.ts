import type { Pool } from 'pg'

// Integration files share a disposable database, including global telemetry counters.
// Serialize their fixtures while preserving concurrent transactions within each test.
export async function acquirePostgresTestLock(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('boron-postgres-integration-fixtures'))")
  } catch (error) {
    client.release()
    throw error
  }
  return async () => {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('boron-postgres-integration-fixtures'))"
      )
    } finally {
      client.release()
    }
  }
}

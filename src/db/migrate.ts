import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool } from 'pg'

export async function migrateDatabase(pool: Pool, directory = migrationDirectory()): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boron_schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort()

  for (const filename of filenames) {
    const exists = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM boron_schema_migrations WHERE filename = $1) AS exists',
      [filename]
    )
    if (exists.rows[0]?.exists) continue
    const sql = await readFile(resolve(directory, filename), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO boron_schema_migrations (filename) VALUES ($1)', [filename])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

function migrationDirectory(): string {
  return resolve(process.cwd(), 'migrations')
}

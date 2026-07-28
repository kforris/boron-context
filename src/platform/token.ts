import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function loadOrCreateToken(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length < 32) throw new Error(`Token at ${path} is too short`)
    return existing
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('base64url')
  await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
  return token
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

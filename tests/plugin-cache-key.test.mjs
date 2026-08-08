import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePluginCacheKey } from '../scripts/verify-plugin-cache-key.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = join(repositoryRoot, 'plugins', 'boron-context')
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('Codex plugin cache key', () => {
  it('matches the complete checked-in plugin payload and package version', async () => {
    const result = await validatePluginCacheKey({ pluginRoot, packageRoot: repositoryRoot })
    expect(result.cacheKey).toMatch(/^[0-9a-f]{12}$/)
  })

  it('rejects a changed payload until the manifest cache key is refreshed', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'boron-plugin-cache-key-'))
    temporaryRoots.push(temporaryRoot)
    const copiedPlugin = join(temporaryRoot, 'boron-context')
    await cp(pluginRoot, copiedPlugin, { recursive: true })
    await appendFile(
      join(copiedPlugin, 'skills', 'context-continuity', 'SKILL.md'),
      '\nPayload mutation for cache-key verification.\n'
    )

    await expect(
      validatePluginCacheKey({ pluginRoot: copiedPlugin, packageRoot: repositoryRoot })
    ).rejects.toThrow(/cache key .* is stale; expected payload digest/)
  })
})

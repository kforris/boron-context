#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifestRelativePath = '.codex-plugin/plugin.json'
const cacheVersionPattern = /^(\d+\.\d+\.\d+)\+codex\.([0-9a-f]{12})$/

export async function computePluginPayloadDigest(pluginRoot) {
  const root = resolve(pluginRoot)
  const manifestPath = join(root, manifestRelativePath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const coreVersion = parseCoreVersion(manifest.version)
  const files = await listPayloadFiles(root)
  const hash = createHash('sha256')

  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join('/')
    const payload =
      relativePath === manifestRelativePath
        ? Buffer.from(
            `${JSON.stringify({ ...manifest, version: `${coreVersion}+codex.PAYLOAD` })}\n`
          )
        : await readFile(path)
    hash.update(`${relativePath}\0${payload.byteLength}\0`)
    hash.update(payload)
    hash.update('\0')
  }

  return hash.digest('hex').slice(0, 12)
}

export async function validatePluginCacheKey({ pluginRoot, packageRoot }) {
  const manifestPath = join(pluginRoot, manifestRelativePath)
  const [manifest, packageJson] = await Promise.all([
    readFile(manifestPath, 'utf8').then(JSON.parse),
    readFile(join(packageRoot, 'package.json'), 'utf8').then(JSON.parse)
  ])
  const match = cacheVersionPattern.exec(manifest.version ?? '')
  if (!match) {
    throw new Error(
      `Plugin version must use <package-version>+codex.<12-hex-payload-digest>; received ${String(
        manifest.version
      )}`
    )
  }
  const [, coreVersion, cacheKey] = match
  if (coreVersion !== packageJson.version) {
    throw new Error(
      `Plugin core version ${coreVersion} does not match package version ${packageJson.version}`
    )
  }
  const expectedCacheKey = await computePluginPayloadDigest(pluginRoot)
  if (cacheKey !== expectedCacheKey) {
    throw new Error(
      `Plugin cache key ${cacheKey} is stale; expected payload digest ${expectedCacheKey}`
    )
  }
  return { version: manifest.version, coreVersion, cacheKey }
}

async function listPayloadFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`Plugin payload contains unsupported filesystem entry: ${path}`)
    }
  }
  await visit(root)
  return files
}

function parseCoreVersion(version) {
  const coreVersion = typeof version === 'string' ? version.split('+', 1)[0] : ''
  if (!/^\d+\.\d+\.\d+$/.test(coreVersion)) {
    throw new Error(`Plugin version has no valid semantic core: ${String(version)}`)
  }
  return coreVersion
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const result = await validatePluginCacheKey({
    pluginRoot: join(repositoryRoot, 'plugins', 'boron-context'),
    packageRoot: repositoryRoot
  })
  process.stdout.write(`Codex plugin cache key OK: ${result.version}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

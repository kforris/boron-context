import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const threeBuildDirectory = dirname(require.resolve('three'))
const assetPaths = new Map([
  ['three.module.js', join(threeBuildDirectory, 'three.module.min.js')],
  ['three.core.min.js', join(threeBuildDirectory, 'three.core.min.js')]
])
const assets = new Map<string, Promise<Buffer>>()

export function readThreeAsset(name: string): Promise<Buffer> | undefined {
  // Serve only the two pinned build artifacts from the installed dependency. Never turn this into
  // a caller-controlled filesystem path.
  const path = assetPaths.get(name)
  if (!path) return undefined
  const existing = assets.get(name)
  if (existing) return existing
  const loaded = readFile(path)
  assets.set(name, loaded)
  return loaded
}

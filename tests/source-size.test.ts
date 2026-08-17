import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ActivityEvidenceInput } from '../src/core/contracts.js'
import { instrumentActivityEvidenceSourceSize } from '../src/core/source-size.js'

describe('activity evidence source-size instrumentation', () => {
  it('measures an explicitly referenced local text file without reading remote content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-source-size-'))
    const path = join(root, 'evidence.md')
    await writeFile(path, '12345678')

    const result = await instrumentActivityEvidenceSourceSize(evidence(pathToFileURL(path).href), [
      root
    ])

    expect(result).toMatchObject({
      sourceTokenEstimate: 2,
      metadata: {
        sourceSize: {
          status: 'measured',
          sourceBytes: 8,
          tokenEstimate: 2,
          basis: 'local_file_bytes_divided_by_4'
        }
      }
    })
  })

  it('marks directories as not applicable instead of denominator misses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-source-directory-'))
    const directory = join(root, 'artifacts')
    await mkdir(directory)

    const result = await instrumentActivityEvidenceSourceSize(
      evidence(pathToFileURL(directory).href),
      [root]
    )

    expect(result).toMatchObject({
      metadata: {
        sourceSize: { status: 'not_applicable', reason: 'local_directory_reference' }
      }
    })
    expect(result.sourceTokenEstimate).toBeUndefined()
  })

  it('does not fetch remote sources and exposes the unavailable boundary', async () => {
    const result = await instrumentActivityEvidenceSourceSize(
      evidence('https://example.test/private')
    )

    expect(result).toMatchObject({
      metadata: {
        sourceSize: { status: 'unavailable', reason: 'remote_source_not_fetched' }
      }
    })
    expect(result.sourceTokenEstimate).toBeUndefined()
  })

  it('does not stat a local path outside the confirmed project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boron-source-root-'))
    const outside = join(tmpdir(), 'boron-sensitive.txt')

    const result = await instrumentActivityEvidenceSourceSize(
      evidence(pathToFileURL(outside).href),
      [root]
    )

    expect(result.metadata.sourceSize).toEqual({
      status: 'unavailable',
      reason: 'outside_registered_project_root'
    })
  })

  it('preserves a client-provided token estimate with explicit provenance', async () => {
    const result = await instrumentActivityEvidenceSourceSize({
      ...evidence('https://example.test/measured'),
      sourceTokenEstimate: 123
    })

    expect(result.metadata.sourceSize).toEqual({
      status: 'measured',
      tokenEstimate: 123,
      basis: 'client_reported_token_estimate'
    })
  })
})

function evidence(uri: string): ActivityEvidenceInput {
  return {
    layer: 'codebase',
    title: 'Source evidence',
    uri,
    excerpt: 'Bounded evidence excerpt.',
    confidence: 1,
    authority: 1,
    metadata: {}
  }
}

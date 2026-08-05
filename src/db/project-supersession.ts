import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

const mergeSchema = z.object({
  action: z.literal('merge'),
  sourceUri: z.string().trim().min(1),
  targetMatchSourceUri: z.string().trim().min(1),
  targetCanonicalSourceUri: z.string().trim().min(1).optional(),
  canonicalName: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).default([]),
  sessionIds: z.array(z.string().uuid()).default([]),
  reason: z.string().trim().min(1)
})

const archiveSchema = z.object({
  action: z.literal('archive'),
  sourceUri: z.string().trim().min(1),
  reason: z.string().trim().min(1)
})

const manifestSchema = z.object({
  version: z.literal(1),
  authority: z.literal('user_approved'),
  provenance: z.string().trim().min(1),
  repairs: z.array(z.discriminatedUnion('action', [mergeSchema, archiveSchema])).min(1)
})

export type ProjectSupersessionManifest = z.infer<typeof manifestSchema>

export interface ProjectSupersessionResult {
  readonly applied: boolean
  readonly mergedProjects: number
  readonly archivedProjects: number
  readonly reassignedSessions: number
  readonly plan: readonly {
    readonly action: 'merge' | 'archive'
    readonly sourceProjectId: string
    readonly sourceName: string
    readonly sourceUri: string
    readonly targetProjectId?: string
    readonly targetName?: string
    readonly targetUri?: string
    readonly reason: string
  }[]
}

export async function loadProjectSupersessionManifest(
  path: string
): Promise<{ readonly manifest: ProjectSupersessionManifest; readonly uri: string }> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  return { manifest, uri: pathToFileURL(path).href }
}

export async function reconcileProjectSupersessions(
  pool: Pool,
  input: { readonly manifest: ProjectSupersessionManifest; readonly manifestUri: string },
  apply: boolean
): Promise<ProjectSupersessionResult> {
  const plan = await planRepairs(pool, input.manifest)
  if (!apply) {
    return { applied: false, mergedProjects: 0, archivedProjects: 0, reassignedSessions: 0, plan }
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('boron-project-supersession'))")
    const lockedPlan = await planRepairs(client, input.manifest)
    let mergedProjects = 0
    let archivedProjects = 0
    let reassignedSessions = 0
    for (let index = 0; index < input.manifest.repairs.length; index += 1) {
      const repair = input.manifest.repairs[index]!
      const item = lockedPlan[index]!
      const provenance = {
        superseded: true,
        supersededReason: repair.reason,
        provenance: input.manifest.provenance,
        manifestUri: input.manifestUri
      }
      if (repair.action === 'archive') {
        await archiveProject(client, item.sourceProjectId, provenance)
        archivedProjects += 1
        continue
      }
      const targetProjectId = item.targetProjectId!
      await client.query(
        `
          UPDATE project_aliases
          SET
            confirmation_state = 'rejected',
            metadata = metadata || $2::jsonb,
            updated_at = now()
          WHERE project_id = $1::uuid AND confirmation_state <> 'rejected'
        `,
        [
          item.sourceProjectId,
          JSON.stringify({ ...provenance, supersededByProjectId: targetProjectId })
        ]
      )
      const moved = await reassignProjectHistory(client, item.sourceProjectId, targetProjectId)
      reassignedSessions += moved
      const targetUri = repair.targetCanonicalSourceUri ?? item.targetUri!
      await client.query(
        `
          UPDATE projects
          SET
            name = $2,
            source_uri = $3,
            status = 'confirmed',
            metadata = metadata || $4::jsonb,
            updated_at = now()
          WHERE id = $1::uuid
        `,
        [
          targetProjectId,
          repair.canonicalName,
          targetUri,
          JSON.stringify({
            canonicalIdentity: true,
            identityAuthority: 'user_approved',
            identityProvenance: input.manifest.provenance,
            supersessionManifestUri: input.manifestUri
          })
        ]
      )
      for (const alias of new Set([repair.canonicalName, ...repair.aliases])) {
        await client.query(
          `
            INSERT INTO project_aliases (
              project_id, alias, normalized_alias, source_uri, confirmation_state, metadata
            )
            VALUES ($1::uuid, $2, lower(trim($2)), $3, 'confirmed', $4::jsonb)
            ON CONFLICT (project_id, normalized_alias)
            DO UPDATE SET
              alias = EXCLUDED.alias,
              source_uri = EXCLUDED.source_uri,
              confirmation_state = 'confirmed',
              metadata = project_aliases.metadata || EXCLUDED.metadata,
              updated_at = now()
          `,
          [
            targetProjectId,
            alias,
            targetUri,
            JSON.stringify({
              identity: true,
              authority: 'user_approved',
              provenance: input.manifest.provenance,
              manifestUri: input.manifestUri
            })
          ]
        )
      }
      if (repair.sessionIds.length > 0) {
        const adopted = await client.query(
          `
            UPDATE agent_sessions
            SET
              project_id = $1::uuid,
              metadata = metadata || $3::jsonb
            WHERE id = ANY($2::uuid[]) AND project_id IS NULL
          `,
          [
            targetProjectId,
            repair.sessionIds,
            JSON.stringify({
              projectIdentityRepair: true,
              provenance: input.manifest.provenance,
              manifestUri: input.manifestUri
            })
          ]
        )
        reassignedSessions += adopted.rowCount ?? 0
      }
      await archiveProject(client, item.sourceProjectId, {
        ...provenance,
        supersededByProjectId: targetProjectId,
        supersededBySourceUri: targetUri
      })
      mergedProjects += 1
    }
    await client.query('COMMIT')
    return {
      applied: true,
      mergedProjects,
      archivedProjects,
      reassignedSessions,
      plan: lockedPlan
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function planRepairs(
  pool: Pool | PoolClient,
  manifest: ProjectSupersessionManifest
): Promise<ProjectSupersessionResult['plan']> {
  const result: ProjectSupersessionResult['plan'][number][] = []
  for (const repair of manifest.repairs) {
    const source = await projectBySourceUri(pool, repair.sourceUri)
    if (!source) throw new Error(`Supersession source project not found: ${repair.sourceUri}`)
    if (repair.action === 'archive') {
      result.push({
        action: 'archive',
        sourceProjectId: source.id,
        sourceName: source.name,
        sourceUri: source.sourceUri,
        reason: repair.reason
      })
      continue
    }
    const target =
      (await projectBySourceUri(pool, repair.targetMatchSourceUri)) ??
      (repair.targetCanonicalSourceUri
        ? await projectBySourceUri(pool, repair.targetCanonicalSourceUri)
        : null)
    if (!target)
      throw new Error(`Supersession target project not found: ${repair.targetMatchSourceUri}`)
    if (source.id === target.id) throw new Error('Supersession source and target must differ')
    const targetUri = repair.targetCanonicalSourceUri ?? target.sourceUri
    const collision = await projectBySourceUri(pool, targetUri)
    if (collision && collision.id !== target.id) {
      throw new Error(
        `Canonical project source URI already belongs to another project: ${targetUri}`
      )
    }
    result.push({
      action: 'merge',
      sourceProjectId: source.id,
      sourceName: source.name,
      sourceUri: source.sourceUri,
      targetProjectId: target.id,
      targetName: repair.canonicalName,
      targetUri,
      reason: repair.reason
    })
  }
  return result
}

async function projectBySourceUri(
  pool: Pool | PoolClient,
  sourceUri: string
): Promise<{ readonly id: string; readonly name: string; readonly sourceUri: string } | null> {
  const result = await pool.query<{ id: string; name: string; source_uri: string }>(
    'SELECT id::text, name, source_uri FROM projects WHERE source_uri = $1 LIMIT 2',
    [sourceUri]
  )
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!
  return { id: row.id, name: row.name, sourceUri: row.source_uri }
}

async function archiveProject(
  client: PoolClient,
  projectId: string,
  provenance: Readonly<Record<string, unknown>>
): Promise<void> {
  await client.query(
    `
      UPDATE project_aliases
      SET
        confirmation_state = 'rejected',
        metadata = metadata || $2::jsonb,
        updated_at = now()
      WHERE project_id = $1::uuid AND confirmation_state <> 'rejected'
    `,
    [projectId, JSON.stringify(provenance)]
  )
  await client.query(
    `
      UPDATE projects
      SET status = 'archived', metadata = metadata || $2::jsonb, updated_at = now()
      WHERE id = $1::uuid
    `,
    [projectId, JSON.stringify(provenance)]
  )
}

async function reassignProjectHistory(
  client: PoolClient,
  sourceProjectId: string,
  targetProjectId: string
): Promise<number> {
  let sessions = 0
  await client.query(
    `
      UPDATE retrieval_policies source
      SET project_id = $2::uuid, updated_at = now()
      WHERE source.project_id = $1::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM retrieval_policies target
          WHERE target.project_id = $2::uuid
            AND target.name = source.name
            AND target.source_uri = source.source_uri
        )
    `,
    [sourceProjectId, targetProjectId]
  )
  for (const table of [
    'intentions',
    'agent_sessions',
    'activities',
    'context_capsules',
    'context_meter_samples',
    'evidence',
    'manual_corrections',
    'objects'
  ]) {
    const moved = await client.query(
      `UPDATE ${table} SET project_id = $2::uuid WHERE project_id = $1::uuid`,
      [sourceProjectId, targetProjectId]
    )
    if (table === 'agent_sessions') sessions += moved.rowCount ?? 0
  }
  return sessions
}

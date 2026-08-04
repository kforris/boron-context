import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

const codexProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  rootPaths: z.array(z.string().trim().min(1)).default([]),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional()
})

const codexStateSchema = z.object({
  'local-projects': z.record(z.string().uuid(), codexProjectSchema),
  'project-order': z.array(z.string().uuid()).optional()
})

const registryManifestSchema = z.object({
  version: z.literal(1),
  authority: z.literal('user_approved'),
  provenance: z.string().trim().min(1),
  projects: z
    .record(
      z.string().uuid(),
      z.object({
        canonicalName: z.string().trim().min(1).optional(),
        aliases: z.array(z.string().trim().min(1)).default([]),
        adoptProjectSourceUri: z.string().trim().min(1).optional(),
        adoptObjectUri: z.string().trim().min(1).optional(),
        replaceProjectSourceUri: z.boolean().default(false),
        removeLegacyLocalRoot: z.boolean().default(false),
        authoritativeRoots: z.array(z.string().trim().min(1)).default([])
      })
    )
    .default({}),
  supersedeAliases: z
    .array(
      z.object({
        ownerSourceUri: z.string().trim().min(1),
        alias: z.string().trim().min(1),
        supersededByCodexProjectId: z.string().uuid(),
        reason: z.string().trim().min(1)
      })
    )
    .default([]),
  supersedeObjects: z
    .array(
      z.object({
        objectCanonicalUri: z.string().trim().min(1),
        supersededByObjectUri: z.string().trim().min(1),
        reason: z.string().trim().min(1),
        closeCurrentRelations: z.literal(true)
      })
    )
    .default([]),
  standaloneIdentities: z
    .array(
      z.object({
        ownerSourceUri: z.string().trim().min(1),
        aliases: z.array(z.string().trim().min(1)).min(1),
        reason: z.string().trim().min(1)
      })
    )
    .default([])
})

export type CodexState = z.infer<typeof codexStateSchema>
export type RegistryManifest = z.infer<typeof registryManifestSchema>

export interface DiscoveredCodexProject {
  readonly codexProjectId: string
  readonly codexName: string
  readonly canonicalName: string
  readonly aliases: readonly string[]
  readonly roots: readonly string[]
  readonly ignoredRoots: readonly { readonly path: string; readonly reason: string }[]
  readonly adoptProjectSourceUri?: string
  readonly adoptObjectUri?: string
  readonly replaceProjectSourceUri: boolean
  readonly removeLegacyLocalRoot: boolean
}

export interface CodexRegistry {
  readonly provenance: string
  readonly authority: 'user_approved'
  readonly stateUri: string
  readonly manifestUri: string
  readonly projects: readonly DiscoveredCodexProject[]
  readonly supersedeAliases: RegistryManifest['supersedeAliases']
  readonly supersedeObjects: RegistryManifest['supersedeObjects']
  readonly standaloneIdentities: RegistryManifest['standaloneIdentities']
}

interface ExistingAlias {
  readonly alias: string
  readonly normalizedAlias: string
  readonly confirmationState: string
}

interface ExistingProject {
  readonly id: string
  readonly name: string
  readonly sourceUri: string
  readonly status: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly aliases: readonly ExistingAlias[]
}

export interface RegistryProjectPlan {
  readonly codexProjectId: string
  readonly canonicalName: string
  readonly aliases: readonly string[]
  readonly roots: readonly string[]
  readonly ignoredRoots: DiscoveredCodexProject['ignoredRoots']
  readonly projectId: string | null
  readonly matchReason: 'manifest' | 'codex_id' | 'codex_uri' | 'exact_root' | 'create'
  readonly currentName: string | null
  readonly currentSourceUri: string | null
  readonly targetSourceUri: string
  readonly removeLegacyLocalRoot: boolean
  readonly groupObject: {
    readonly id: string
    readonly name: string
    readonly canonicalUri: string
    readonly currentProjectId: string | null
  } | null
  readonly confirmedWorkspaceProjects: readonly {
    readonly id: string
    readonly name: string
    readonly sourceUri: string
  }[]
  readonly candidateProjects: readonly {
    readonly id: string
    readonly name: string
    readonly sourceUri: string
  }[]
}

export interface RegistryPlan {
  readonly source: {
    readonly stateUri: string
    readonly manifestUri: string
    readonly provenance: string
  }
  readonly projects: readonly RegistryProjectPlan[]
  readonly supersedeAliases: readonly {
    readonly ownerProjectId: string
    readonly ownerName: string
    readonly alias: string
    readonly supersededByCodexProjectId: string
    readonly reason: string
  }[]
  readonly supersedeObjects: readonly {
    readonly objectId: string
    readonly objectName: string
    readonly objectCanonicalUri: string
    readonly supersededByObjectId: string
    readonly supersededByObjectName: string
    readonly supersededByObjectUri: string
    readonly reason: string
    readonly closeCurrentRelations: true
    readonly currentRelationCount: number
  }[]
  readonly standaloneIdentities: readonly {
    readonly ownerProjectId: string
    readonly ownerName: string
    readonly ownerSourceUri: string
    readonly aliases: readonly string[]
    readonly reason: string
  }[]
}

export interface RegistryApplyResult {
  readonly applied: boolean
  readonly projectsCreated: number
  readonly projectsAdopted: number
  readonly canonicalAliases: number
  readonly aliasesSuperseded: number
  readonly objectsSuperseded: number
  readonly relationsSuperseded: number
  readonly confirmedRootRelations: number
  readonly confirmedWorkspaceRelations: number
  readonly candidateWorkspaceRelations: number
  readonly plan: RegistryPlan
}

export async function loadCodexRegistry(input: {
  readonly statePath: string
  readonly manifestPath: string
  readonly homeRoot?: string
}): Promise<CodexRegistry> {
  const [stateText, manifestText] = await Promise.all([
    readFile(input.statePath, 'utf8'),
    readFile(input.manifestPath, 'utf8')
  ])
  const state = codexStateSchema.parse(JSON.parse(stateText))
  const manifest = registryManifestSchema.parse(JSON.parse(manifestText))
  const projects = await discoverCodexProjects(state, manifest, input.homeRoot ?? homedir())
  return {
    provenance: manifest.provenance,
    authority: manifest.authority,
    stateUri: pathToFileURL(resolve(input.statePath)).href,
    manifestUri: pathToFileURL(resolve(input.manifestPath)).href,
    projects,
    supersedeAliases: manifest.supersedeAliases,
    supersedeObjects: manifest.supersedeObjects,
    standaloneIdentities: manifest.standaloneIdentities
  }
}

export async function discoverCodexProjects(
  stateInput: unknown,
  manifestInput: unknown,
  homeRoot: string,
  directoryExists: (path: string) => Promise<boolean> = isDirectory
): Promise<readonly DiscoveredCodexProject[]> {
  const state = codexStateSchema.parse(stateInput)
  const manifest = registryManifestSchema.parse(manifestInput)
  const orderedIds = orderedProjectIds(state)
  const projects: DiscoveredCodexProject[] = []
  const identityOwners = new Map<string, string>()
  for (const id of orderedIds) {
    const source = state['local-projects'][id]
    if (!source) continue
    const override = manifest.projects[id]
    const canonicalName = override?.canonicalName ?? source.name
    const aliases = uniqueStrings([canonicalName, source.name, ...(override?.aliases ?? [])])
    for (const alias of aliases) {
      const normalized = normalize(alias)
      const owner = identityOwners.get(normalized)
      if (owner && owner !== id) {
        throw new Error(`Canonical project identity collision: ${alias} (${owner}, ${id})`)
      }
      identityOwners.set(normalized, id)
    }
    const rootInputs = uniqueStrings([
      ...source.rootPaths,
      ...(override?.authoritativeRoots ?? [])
    ]).map((path) => resolve(path))
    const roots: string[] = []
    const ignoredRoots: { path: string; reason: string }[] = []
    for (const root of rootInputs) {
      if (root === resolve(homeRoot)) {
        ignoredRoots.push({ path: root, reason: 'broad_home_root' })
      } else if (!(await directoryExists(root))) {
        ignoredRoots.push({ path: root, reason: 'missing_directory' })
      } else {
        roots.push(root)
      }
    }
    projects.push({
      codexProjectId: id,
      codexName: source.name,
      canonicalName,
      aliases,
      roots: uniqueStrings(roots),
      ignoredRoots,
      ...(override?.adoptProjectSourceUri
        ? { adoptProjectSourceUri: override.adoptProjectSourceUri }
        : {}),
      ...(override?.adoptObjectUri ? { adoptObjectUri: override.adoptObjectUri } : {}),
      replaceProjectSourceUri: override?.replaceProjectSourceUri ?? false,
      removeLegacyLocalRoot: override?.removeLegacyLocalRoot ?? false
    })
  }
  return projects
}

export async function planCodexRegistry(
  pool: Pool | PoolClient,
  registry: CodexRegistry
): Promise<RegistryPlan> {
  const existing = await loadExistingProjects(pool)
  const supersededKeys = new Set(
    registry.supersedeAliases.map((rule) => `${rule.ownerSourceUri}\u0000${normalize(rule.alias)}`)
  )
  const supersedeAliases = registry.supersedeAliases.map((rule) => {
    const owners = existing.filter(
      (project) =>
        project.sourceUri === rule.ownerSourceUri ||
        stringArray(project.metadata.supersededSourceUris).includes(rule.ownerSourceUri)
    )
    if (owners.length !== 1) {
      throw new Error(
        `Superseded alias owner is not unique: ${rule.ownerSourceUri} (${owners.length})`
      )
    }
    const owner = owners[0]!
    const alias = owner.aliases.find((item) => item.normalizedAlias === normalize(rule.alias))
    if (!alias) {
      throw new Error(`Alias to supersede was not found: ${owner.name} / ${rule.alias}`)
    }
    return {
      ownerProjectId: owner.id,
      ownerName: owner.name,
      alias: rule.alias,
      supersededByCodexProjectId: rule.supersededByCodexProjectId,
      reason: rule.reason
    }
  })
  const standaloneIdentities = registry.standaloneIdentities.map((rule) => {
    const owners = existing.filter(
      (project) =>
        project.sourceUri === rule.ownerSourceUri ||
        stringArray(project.metadata.supersededSourceUris).includes(rule.ownerSourceUri)
    )
    if (owners.length !== 1) {
      throw new Error(
        `Standalone identity owner is not unique: ${rule.ownerSourceUri} (${owners.length})`
      )
    }
    const owner = owners[0]!
    return {
      ownerProjectId: owner.id,
      ownerName: owner.name,
      ownerSourceUri: owner.sourceUri,
      aliases: uniqueStrings(rule.aliases),
      reason: rule.reason
    }
  })
  const supersedeObjects = await Promise.all(
    registry.supersedeObjects.map(async (rule) => {
      const [object, target] = await Promise.all([
        loadObjectByUriForSupersession(pool, rule.objectCanonicalUri),
        loadObjectByUriForSupersession(pool, rule.supersededByObjectUri)
      ])
      if (!object) {
        throw new Error(`Object to supersede was not found: ${rule.objectCanonicalUri}`)
      }
      if (!target || target.confirmationState === 'rejected') {
        throw new Error(
          `Superseding object was not found or is rejected: ${rule.supersededByObjectUri}`
        )
      }
      if (object.id === target.id) {
        throw new Error(`Object cannot supersede itself: ${rule.objectCanonicalUri}`)
      }
      const relationCount = await pool.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM relations
          WHERE valid_to IS NULL
            AND (source_object_id = $1::uuid OR target_object_id = $1::uuid)
        `,
        [object.id]
      )
      return {
        objectId: object.id,
        objectName: object.name,
        objectCanonicalUri: object.canonicalUri,
        supersededByObjectId: target.id,
        supersededByObjectName: target.name,
        supersededByObjectUri: target.canonicalUri,
        reason: rule.reason,
        closeCurrentRelations: rule.closeCurrentRelations,
        currentRelationCount: Number(relationCount.rows[0]?.count ?? 0)
      }
    })
  )
  const plannedIdentityOwners = new Map<string, string>()
  for (const project of registry.projects) {
    for (const alias of project.aliases) {
      plannedIdentityOwners.set(normalize(alias), project.codexProjectId)
    }
  }
  for (const identity of standaloneIdentities) {
    for (const alias of identity.aliases) {
      const owner = plannedIdentityOwners.get(normalize(alias))
      if (owner && owner !== identity.ownerProjectId) {
        throw new Error(`Canonical project identity collision: ${alias}`)
      }
      plannedIdentityOwners.set(normalize(alias), identity.ownerProjectId)
    }
  }
  const plans: RegistryProjectPlan[] = []
  const claimedProjects = new Map<string, string>()
  for (const project of registry.projects) {
    const codexUri = `codex-project://${project.codexProjectId}`
    const explicit = project.adoptProjectSourceUri
      ? existing.filter(
          (item) =>
            item.sourceUri === project.adoptProjectSourceUri ||
            stringArray(item.metadata.supersededSourceUris).includes(project.adoptProjectSourceUri!)
        )
      : []
    if (project.adoptProjectSourceUri && explicit.length !== 1) {
      throw new Error(
        `Manifest project adoption is not unique: ${project.adoptProjectSourceUri} (${explicit.length})`
      )
    }
    const byCodexId = existing.filter(
      (item) => item.metadata.codexProjectId === project.codexProjectId
    )
    const byCodexUri = existing.filter((item) => item.sourceUri === codexUri)
    const rootUris = project.roots.map((root) => pathToFileURL(root).href)
    const byRoot = existing.filter(
      (item) =>
        rootUris.includes(item.sourceUri) &&
        (!item.metadata.codexProjectId || item.metadata.codexProjectId === project.codexProjectId)
    )
    const selection = selectAdoption(explicit, byCodexId, byCodexUri, byRoot)
    const adopted = selection.project
    if (adopted) {
      const claimedBy = claimedProjects.get(adopted.id)
      if (claimedBy && claimedBy !== project.codexProjectId) {
        throw new Error(
          `Existing project ${adopted.name} was claimed by two Codex projects: ${claimedBy}, ${project.codexProjectId}`
        )
      }
      claimedProjects.set(adopted.id, project.codexProjectId)
    }
    const groupObject = project.adoptObjectUri
      ? await loadObjectByUri(pool, project.adoptObjectUri)
      : null
    if (project.adoptObjectUri && !groupObject) {
      throw new Error(`Manifest group object was not found: ${project.adoptObjectUri}`)
    }
    const normalizedIdentities = new Set(project.aliases.map(normalize))
    const confirmedWorkspaceProjects = existing
      .filter((item) => item.id !== adopted?.id && rootUris.includes(item.sourceUri))
      .map((item) => ({ id: item.id, name: item.name, sourceUri: item.sourceUri }))
      .sort((left, right) => left.id.localeCompare(right.id))
    const confirmedWorkspaceIds = new Set(confirmedWorkspaceProjects.map((item) => item.id))
    const candidateProjects = existing
      .filter((item) => item.id !== adopted?.id)
      .filter((item) => !confirmedWorkspaceIds.has(item.id))
      .filter((item) => {
        if (normalizedIdentities.has(normalize(item.name))) return true
        return item.aliases.some(
          (alias) =>
            alias.confirmationState === 'confirmed' &&
            !supersededKeys.has(`${item.sourceUri}\u0000${alias.normalizedAlias}`) &&
            normalizedIdentities.has(alias.normalizedAlias)
        )
      })
      .map((item) => ({ id: item.id, name: item.name, sourceUri: item.sourceUri }))
      .sort((left, right) => left.id.localeCompare(right.id))
    plans.push({
      codexProjectId: project.codexProjectId,
      canonicalName: project.canonicalName,
      aliases: project.aliases,
      roots: project.roots,
      ignoredRoots: project.ignoredRoots,
      projectId: adopted?.id ?? null,
      matchReason: selection.reason,
      currentName: adopted?.name ?? null,
      currentSourceUri: adopted?.sourceUri ?? null,
      targetSourceUri: project.replaceProjectSourceUri
        ? codexUri
        : (adopted?.sourceUri ?? codexUri),
      removeLegacyLocalRoot: project.removeLegacyLocalRoot,
      groupObject,
      confirmedWorkspaceProjects,
      candidateProjects
    })
  }
  return {
    source: {
      stateUri: registry.stateUri,
      manifestUri: registry.manifestUri,
      provenance: registry.provenance
    },
    projects: plans,
    supersedeAliases,
    supersedeObjects,
    standaloneIdentities
  }
}

export async function reconcileCodexRegistry(
  pool: Pool,
  registry: CodexRegistry,
  apply: boolean
): Promise<RegistryApplyResult> {
  const initialPlan = await planCodexRegistry(pool, registry)
  if (!apply) return emptyResult(initialPlan)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('boron-codex-project-registry'))")
    const plan = await planCodexRegistry(client, registry)
    let projectsCreated = 0
    let projectsAdopted = 0
    let canonicalAliases = 0
    let aliasesSuperseded = 0
    let objectsSuperseded = 0
    let relationsSuperseded = 0
    let confirmedRootRelations = 0
    let confirmedWorkspaceRelations = 0
    let candidateWorkspaceRelations = 0
    for (const repair of plan.supersedeAliases) {
      const result = await client.query(
        `
          UPDATE project_aliases
          SET
            confirmation_state = 'rejected',
            metadata = metadata || $3::jsonb,
            updated_at = CASE
              WHEN confirmation_state <> 'rejected' OR NOT metadata @> $3::jsonb THEN now()
              ELSE updated_at
            END
          WHERE project_id = $1::uuid
            AND normalized_alias = lower(trim($2))
            AND (confirmation_state <> 'rejected' OR NOT metadata @> $3::jsonb)
        `,
        [
          repair.ownerProjectId,
          repair.alias,
          JSON.stringify({
            superseded: true,
            supersededByCodexProjectId: repair.supersededByCodexProjectId,
            supersededReason: repair.reason,
            provenance: plan.source.provenance
          })
        ]
      )
      aliasesSuperseded += result.rowCount ?? 0
    }
    for (const repair of plan.supersedeObjects) {
      const metadataPatch = {
        superseded: true,
        supersededByObjectUri: repair.supersededByObjectUri,
        supersededReason: repair.reason,
        provenance: plan.source.provenance
      }
      const objectResult = await client.query(
        `
          UPDATE objects
          SET
            confirmation_state = 'rejected',
            metadata = metadata
              || jsonb_build_object('previousConfirmationState', confirmation_state)
              || $2::jsonb,
            updated_at = now()
          WHERE id = $1::uuid
            AND (confirmation_state <> 'rejected' OR NOT metadata @> $2::jsonb)
        `,
        [repair.objectId, JSON.stringify(metadataPatch)]
      )
      objectsSuperseded += objectResult.rowCount ?? 0
      if (repair.closeCurrentRelations) {
        const relationResult = await client.query(
          `
            UPDATE relations
            SET
              valid_to = now(),
              provenance = provenance || $2::jsonb,
              updated_at = now()
            WHERE valid_to IS NULL
              AND (source_object_id = $1::uuid OR target_object_id = $1::uuid)
          `,
          [repair.objectId, JSON.stringify(metadataPatch)]
        )
        relationsSuperseded += relationResult.rowCount ?? 0
      }
    }
    for (const identity of plan.standaloneIdentities) {
      for (const alias of identity.aliases) {
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
              updated_at = CASE
                WHEN project_aliases.alias IS DISTINCT FROM EXCLUDED.alias
                  OR project_aliases.source_uri IS DISTINCT FROM EXCLUDED.source_uri
                  OR project_aliases.confirmation_state IS DISTINCT FROM 'confirmed'
                  OR NOT project_aliases.metadata @> EXCLUDED.metadata
                THEN now()
                ELSE project_aliases.updated_at
              END
          `,
          [
            identity.ownerProjectId,
            alias,
            identity.ownerSourceUri,
            JSON.stringify({
              identity: true,
              authority: 'user_approved',
              provenance: plan.source.provenance,
              reason: identity.reason
            })
          ]
        )
        canonicalAliases += 1
      }
    }
    const projectIdByCodexId = new Map<string, string>()
    for (const item of plan.projects) {
      const existing = item.projectId ? await loadProjectById(client, item.projectId) : null
      const metadataPatch = projectMetadataPatch(existing, item, plan)
      let projectId: string
      if (existing) {
        const result = await client.query<{ id: string }>(
          `
            UPDATE projects
            SET
              name = $2,
              source_uri = $3,
              status = 'confirmed',
              metadata = (CASE WHEN $5::boolean THEN metadata - 'localRoot' ELSE metadata END)
                || $4::jsonb,
              updated_at = CASE
                WHEN name IS DISTINCT FROM $2
                  OR source_uri IS DISTINCT FROM $3
                  OR status IS DISTINCT FROM 'confirmed'
                  OR NOT metadata @> $4::jsonb
                THEN now()
                ELSE updated_at
              END
            WHERE id = $1::uuid
            RETURNING id::text
          `,
          [
            existing.id,
            item.canonicalName,
            item.targetSourceUri,
            JSON.stringify(metadataPatch),
            item.removeLegacyLocalRoot
          ]
        )
        projectId = result.rows[0]!.id
        projectsAdopted += 1
      } else {
        const result = await client.query<{ id: string }>(
          `
            INSERT INTO projects (name, source_uri, status, metadata)
            VALUES ($1, $2, 'confirmed', $3::jsonb)
            RETURNING id::text
          `,
          [item.canonicalName, item.targetSourceUri, JSON.stringify(metadataPatch)]
        )
        projectId = result.rows[0]!.id
        projectsCreated += 1
      }
      projectIdByCodexId.set(item.codexProjectId, projectId)
      for (const alias of item.aliases) {
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
              updated_at = CASE
                WHEN project_aliases.alias IS DISTINCT FROM EXCLUDED.alias
                  OR project_aliases.source_uri IS DISTINCT FROM EXCLUDED.source_uri
                  OR project_aliases.confirmation_state IS DISTINCT FROM 'confirmed'
                  OR NOT project_aliases.metadata @> EXCLUDED.metadata
                THEN now()
                ELSE project_aliases.updated_at
              END
          `,
          [
            projectId,
            alias,
            item.targetSourceUri,
            JSON.stringify({
              identity: true,
              codexProjectId: item.codexProjectId,
              authority: 'user_approved',
              provenance: plan.source.provenance
            })
          ]
        )
        canonicalAliases += 1
      }
      const groupObjectId = item.groupObject
        ? await adoptGroupObject(client, {
            object: item.groupObject,
            projectId,
            canonicalName: item.canonicalName,
            codexProjectId: item.codexProjectId,
            provenance: plan.source.provenance
          })
        : await ensureObject(client, {
            projectId,
            kind: 'project_group',
            name: item.canonicalName,
            canonicalUri: `codex-project://${item.codexProjectId}#project-group`,
            confirmationState: 'confirmed',
            metadata: {
              codexProjectId: item.codexProjectId,
              authority: 'user_approved',
              provenance: plan.source.provenance
            }
          })
      for (const root of item.roots) {
        const rootObjectId = await ensureObject(client, {
          projectId,
          kind: 'local_root',
          name: basename(root),
          canonicalUri: `codex-project://${item.codexProjectId}/registered-root/${encodeURIComponent(root)}`,
          confirmationState: 'confirmed',
          metadata: {
            codexProjectId: item.codexProjectId,
            path: root,
            authority: 'codex_local_project_state',
            sourceUri: plan.source.stateUri
          }
        })
        if (
          await ensureRelation(client, {
            sourceObjectId: groupObjectId,
            relationType: 'HAS_REGISTERED_ROOT',
            targetObjectId: rootObjectId,
            confidence: 1,
            confirmationState: 'confirmed',
            provenance: {
              source: 'codex_local_project_state',
              sourceUri: plan.source.stateUri,
              codexProjectId: item.codexProjectId,
              modelProposed: false,
              rationale:
                'The exact non-home root is registered in authoritative local Codex project metadata.'
            }
          })
        ) {
          confirmedRootRelations += 1
        }
      }
      for (const workspacePlan of item.confirmedWorkspaceProjects) {
        const workspace = await loadProjectById(client, workspacePlan.id)
        if (!workspace) continue
        const workspaceObjectId = await ensureObject(client, {
          projectId: workspace.id,
          kind: 'project_scope',
          name: workspace.name,
          canonicalUri: `boron://project-scope/${workspace.id}`,
          confirmationState: 'confirmed',
          metadata: { sourceUri: workspace.sourceUri, source: 'existing_ontology_project' }
        })
        await supersedeCandidateWorkspaceRelation(client, groupObjectId, workspaceObjectId)
        if (
          await ensureRelation(client, {
            sourceObjectId: groupObjectId,
            relationType: 'HAS_REGISTERED_WORKSPACE',
            targetObjectId: workspaceObjectId,
            confidence: 1,
            confirmationState: 'confirmed',
            provenance: {
              source: 'codex_local_project_state',
              sourceUri: plan.source.stateUri,
              codexProjectId: item.codexProjectId,
              modelProposed: false,
              rationale:
                'The existing ontology project source exactly matches a confirmed registered non-home root.'
            }
          })
        ) {
          confirmedWorkspaceRelations += 1
        }
      }
      for (const candidatePlan of item.candidateProjects) {
        const candidate = await loadProjectById(client, candidatePlan.id)
        if (!candidate) continue
        const candidateObjectId = await ensureObject(client, {
          projectId: candidate.id,
          kind: 'project_scope',
          name: candidate.name,
          canonicalUri: `boron://project-scope/${candidate.id}`,
          confirmationState: 'confirmed',
          metadata: { sourceUri: candidate.sourceUri, source: 'existing_ontology_project' }
        })
        if (
          await ensureRelation(client, {
            sourceObjectId: groupObjectId,
            relationType: 'MAY_INCLUDE_WORKSPACE',
            targetObjectId: candidateObjectId,
            confidence: 0.6,
            confirmationState: 'candidate',
            provenance: {
              source: 'deterministic_codex_project_discovery',
              sourceUri: plan.source.stateUri,
              codexProjectId: item.codexProjectId,
              modelProposed: false,
              rationale:
                'An exact normalized name or historical alias matched, but no authoritative root or explicit adoption established the relationship.'
            }
          })
        ) {
          candidateWorkspaceRelations += 1
        }
      }
    }
    for (const repair of plan.supersedeAliases) {
      if (!projectIdByCodexId.has(repair.supersededByCodexProjectId)) {
        throw new Error(
          `Superseded alias target is not registered: ${repair.supersededByCodexProjectId}`
        )
      }
    }
    await client.query('COMMIT')
    return {
      applied: true,
      projectsCreated,
      projectsAdopted,
      canonicalAliases,
      aliasesSuperseded,
      objectsSuperseded,
      relationsSuperseded,
      confirmedRootRelations,
      confirmedWorkspaceRelations,
      candidateWorkspaceRelations,
      plan
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function orderedProjectIds(state: CodexState): readonly string[] {
  const known = Object.keys(state['local-projects'])
  const ordered = state['project-order'] ?? []
  return [
    ...ordered.filter((id) => known.includes(id)),
    ...known.filter((id) => !ordered.includes(id))
  ]
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function selectAdoption(
  explicit: readonly ExistingProject[],
  byCodexId: readonly ExistingProject[],
  byCodexUri: readonly ExistingProject[],
  byRoot: readonly ExistingProject[]
): {
  readonly project: ExistingProject | null
  readonly reason: RegistryProjectPlan['matchReason']
} {
  if (explicit.length === 1) return { project: explicit[0]!, reason: 'manifest' }
  if (byCodexId.length === 1) return { project: byCodexId[0]!, reason: 'codex_id' }
  if (byCodexId.length > 1) throw new Error('Codex project ID maps to multiple ontology projects')
  if (byCodexUri.length === 1) return { project: byCodexUri[0]!, reason: 'codex_uri' }
  if (byCodexUri.length > 1) throw new Error('Codex project URI maps to multiple ontology projects')
  if (byRoot.length === 1) return { project: byRoot[0]!, reason: 'exact_root' }
  return { project: null, reason: 'create' }
}

async function loadExistingProjects(pool: Pool | PoolClient): Promise<readonly ExistingProject[]> {
  const result = await pool.query<{
    id: string
    name: string
    source_uri: string
    status: string
    metadata: Record<string, unknown>
    aliases: ExistingAlias[]
  }>(
    `
      SELECT
        p.id::text,
        p.name,
        p.source_uri,
        p.status,
        p.metadata,
        coalesce(
          jsonb_agg(jsonb_build_object(
            'alias', a.alias,
            'normalizedAlias', a.normalized_alias,
            'confirmationState', a.confirmation_state
          ) ORDER BY a.normalized_alias) FILTER (WHERE a.id IS NOT NULL),
          '[]'::jsonb
        ) AS aliases
      FROM projects p
      LEFT JOIN project_aliases a ON a.project_id = p.id
      GROUP BY p.id
      ORDER BY lower(p.name), p.id
    `
  )
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    sourceUri: row.source_uri,
    status: row.status,
    metadata: row.metadata,
    aliases: row.aliases
  }))
}

async function loadProjectById(client: PoolClient, id: string): Promise<ExistingProject | null> {
  const projects = await loadExistingProjects(client)
  return projects.find((project) => project.id === id) ?? null
}

async function loadObjectByUri(
  pool: Pool | PoolClient,
  canonicalUri: string
): Promise<NonNullable<RegistryProjectPlan['groupObject']> | null> {
  const result = await pool.query<{
    id: string
    name: string
    canonical_uri: string
    project_id: string | null
  }>(
    `
      SELECT id::text, name, canonical_uri, project_id::text
      FROM objects
      WHERE canonical_uri = $1
        AND confirmation_state <> 'rejected'
      LIMIT 2
    `,
    [canonicalUri]
  )
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!
  return {
    id: row.id,
    name: row.name,
    canonicalUri: row.canonical_uri,
    currentProjectId: row.project_id
  }
}

async function loadObjectByUriForSupersession(
  pool: Pool | PoolClient,
  canonicalUri: string
): Promise<{
  readonly id: string
  readonly name: string
  readonly canonicalUri: string
  readonly confirmationState: string
} | null> {
  const result = await pool.query<{
    id: string
    name: string
    canonical_uri: string
    confirmation_state: string
  }>(
    `
      SELECT id::text, name, canonical_uri, confirmation_state
      FROM objects
      WHERE canonical_uri = $1
      LIMIT 2
    `,
    [canonicalUri]
  )
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!
  return {
    id: row.id,
    name: row.name,
    canonicalUri: row.canonical_uri,
    confirmationState: row.confirmation_state
  }
}

function projectMetadataPatch(
  existing: ExistingProject | null,
  item: RegistryProjectPlan,
  plan: RegistryPlan
): Record<string, unknown> {
  const previousNames = uniqueStrings([
    ...stringArray(existing?.metadata.previousNames),
    ...(existing && existing.name !== item.canonicalName ? [existing.name] : [])
  ])
  const supersededSourceUris = uniqueStrings([
    ...stringArray(existing?.metadata.supersededSourceUris),
    ...(existing && existing.sourceUri !== item.targetSourceUri ? [existing.sourceUri] : [])
  ])
  const supersededLocalRoots = uniqueStrings([
    ...stringArray(existing?.metadata.supersededLocalRoots),
    ...(item.removeLegacyLocalRoot && typeof existing?.metadata.localRoot === 'string'
      ? [existing.metadata.localRoot]
      : [])
  ])
  return {
    codexProjectId: item.codexProjectId,
    canonicalIdentity: true,
    identityAuthority: 'user_approved',
    identityProvenance: plan.source.provenance,
    codexStateUri: plan.source.stateUri,
    registryManifestUri: plan.source.manifestUri,
    registeredRoots: item.roots,
    ...(previousNames.length > 0 ? { previousNames } : {}),
    ...(supersededSourceUris.length > 0 ? { supersededSourceUris } : {}),
    ...(supersededLocalRoots.length > 0 ? { supersededLocalRoots } : {})
  }
}

async function ensureObject(
  client: PoolClient,
  input: {
    readonly projectId: string
    readonly kind: string
    readonly name: string
    readonly canonicalUri: string
    readonly confirmationState: 'candidate' | 'confirmed'
    readonly metadata: Readonly<Record<string, unknown>>
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO objects (
        project_id, kind, name, canonical_uri, confirmation_state, metadata
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (canonical_uri)
      DO UPDATE SET
        project_id = EXCLUDED.project_id,
        kind = EXCLUDED.kind,
        name = EXCLUDED.name,
        confirmation_state = EXCLUDED.confirmation_state,
        metadata = objects.metadata || EXCLUDED.metadata,
        updated_at = CASE
          WHEN objects.project_id IS DISTINCT FROM EXCLUDED.project_id
            OR objects.kind IS DISTINCT FROM EXCLUDED.kind
            OR objects.name IS DISTINCT FROM EXCLUDED.name
            OR objects.confirmation_state IS DISTINCT FROM EXCLUDED.confirmation_state
            OR NOT objects.metadata @> EXCLUDED.metadata
          THEN now()
          ELSE objects.updated_at
        END
      RETURNING id::text
    `,
    [
      input.projectId,
      input.kind,
      input.name,
      input.canonicalUri,
      input.confirmationState,
      JSON.stringify(input.metadata)
    ]
  )
  return result.rows[0]!.id
}

async function adoptGroupObject(
  client: PoolClient,
  input: {
    readonly object: NonNullable<RegistryProjectPlan['groupObject']>
    readonly projectId: string
    readonly canonicalName: string
    readonly codexProjectId: string
    readonly provenance: string
  }
): Promise<string> {
  const metadata = {
    codexProjectId: input.codexProjectId,
    authority: 'user_approved',
    provenance: input.provenance,
    ...(input.object.name !== input.canonicalName ? { previousNames: [input.object.name] } : {}),
    ...(input.object.currentProjectId && input.object.currentProjectId !== input.projectId
      ? { previousProjectIds: [input.object.currentProjectId] }
      : {})
  }
  const result = await client.query<{ id: string }>(
    `
      UPDATE objects
      SET
        project_id = $2::uuid,
        name = $3,
        confirmation_state = 'confirmed',
        metadata = metadata || $4::jsonb,
        updated_at = CASE
          WHEN project_id IS DISTINCT FROM $2::uuid
            OR name IS DISTINCT FROM $3
            OR confirmation_state IS DISTINCT FROM 'confirmed'
            OR NOT metadata @> $4::jsonb
          THEN now()
          ELSE updated_at
        END
      WHERE id = $1::uuid
      RETURNING id::text
    `,
    [input.object.id, input.projectId, input.canonicalName, JSON.stringify(metadata)]
  )
  return result.rows[0]!.id
}

async function ensureRelation(
  client: PoolClient,
  input: {
    readonly sourceObjectId: string
    readonly relationType: string
    readonly targetObjectId: string
    readonly confidence: number
    readonly confirmationState: 'candidate' | 'confirmed'
    readonly provenance: Readonly<Record<string, unknown>>
  }
): Promise<boolean> {
  const existing = await client.query<{ id: string }>(
    `
      SELECT id::text
      FROM current_relations
      WHERE source_object_id = $1::uuid
        AND relation_type = $2
        AND target_object_id = $3::uuid
        AND confirmation_state = $4
      LIMIT 1
    `,
    [input.sourceObjectId, input.relationType, input.targetObjectId, input.confirmationState]
  )
  if (existing.rows[0]) return false
  await client.query(
    `
      INSERT INTO relations (
        source_object_id,
        relation_type,
        target_object_id,
        confidence,
        confirmation_state,
        provenance,
        version
      )
      SELECT
        $1::uuid,
        $2,
        $3::uuid,
        $4,
        $5,
        $6::jsonb,
        coalesce(max(version), 0) + 1
      FROM relations
      WHERE source_object_id = $1::uuid
        AND relation_type = $2
        AND target_object_id = $3::uuid
    `,
    [
      input.sourceObjectId,
      input.relationType,
      input.targetObjectId,
      input.confidence,
      input.confirmationState,
      JSON.stringify(input.provenance)
    ]
  )
  return true
}

async function supersedeCandidateWorkspaceRelation(
  client: PoolClient,
  sourceObjectId: string,
  targetObjectId: string
): Promise<void> {
  await client.query(
    `
      UPDATE relations
      SET
        valid_to = now(),
        provenance = provenance || $3::jsonb,
        updated_at = now()
      WHERE source_object_id = $1::uuid
        AND relation_type = 'MAY_INCLUDE_WORKSPACE'
        AND target_object_id = $2::uuid
        AND confirmation_state = 'candidate'
        AND valid_to IS NULL
    `,
    [
      sourceObjectId,
      targetObjectId,
      JSON.stringify({
        superseded: true,
        supersededByRelationType: 'HAS_REGISTERED_WORKSPACE',
        supersededReason:
          'An exact authoritative registered root now confirms the workspace relationship.'
      })
    ]
  )
}

function emptyResult(plan: RegistryPlan): RegistryApplyResult {
  return {
    applied: false,
    projectsCreated: 0,
    projectsAdopted: 0,
    canonicalAliases: 0,
    aliasesSuperseded: 0,
    objectsSuperseded: 0,
    relationsSuperseded: 0,
    confirmedRootRelations: 0,
    confirmedWorkspaceRelations: 0,
    candidateWorkspaceRelations: 0,
    plan
  }
}

import type { ResolvedProject } from './contracts.js'
import { ProjectScopeError } from './errors.js'

export interface VerifiedActivityProjectScope {
  readonly verification: 'explicit_project'
  readonly projectHint: string
  readonly resolvedProjectId: string
}

export function verifyResolvedActivityProjectScope(
  sessionProjectId: string | null,
  projectHint: string,
  project: ResolvedProject | null
): VerifiedActivityProjectScope {
  if (!project) {
    throw new ProjectScopeError(
      'project_unresolved',
      `Activity target project could not be resolved: ${projectHint}`
    )
  }
  if (!sessionProjectId || project.id !== sessionProjectId) {
    throw new ProjectScopeError(
      'project_mismatch',
      `Activity target project ${project.name} does not match the open session`
    )
  }
  return {
    verification: 'explicit_project',
    projectHint,
    resolvedProjectId: project.id
  }
}

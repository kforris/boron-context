export class ProjectScopeError extends Error {
  constructor(
    readonly reason: 'project_unresolved' | 'project_mismatch',
    message: string
  ) {
    super(message)
    this.name = 'ProjectScopeError'
  }
}

export class ActivityTimestampError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActivityTimestampError'
  }
}

export class ContinuityConflictError extends Error {
  constructor(
    readonly reason: 'relation_precondition_failed' | 'idempotency_conflict' | 'invalid_context_use'
  ) {
    super(reason)
    this.name = 'ContinuityConflictError'
  }
}

export type BoronSessionStatus = 'active' | 'completed' | 'failed' | 'partial' | 'cancelled'

export class SessionLifecycleError extends Error {
  constructor(
    readonly reason: 'session_not_found' | 'session_not_active',
    readonly sessionStatus: Exclude<BoronSessionStatus, 'active'> | null,
    message: string
  ) {
    super(message)
    this.name = 'SessionLifecycleError'
  }
}

export type OntologyGovernanceReason =
  | 'unknown_entity_kind'
  | 'unknown_relation_type'
  | 'confirmed_requires_authority'
  | 'relation_not_active'

export interface OntologyGovernanceDecision {
  readonly outcome: 'accepted' | 'rejected' | 'deprecated'
  readonly reason: string
  readonly typeFamily: 'entity_kind' | 'relation_type' | 'relation_rule'
  readonly typeName: string
  readonly registryStatus?: 'active' | 'legacy' | 'deprecated'
  readonly relationAuthority?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export class OntologyGovernanceError extends Error {
  constructor(
    readonly reason: OntologyGovernanceReason,
    readonly decisions: readonly OntologyGovernanceDecision[],
    message: string
  ) {
    super(message)
    this.name = 'OntologyGovernanceError'
  }
}

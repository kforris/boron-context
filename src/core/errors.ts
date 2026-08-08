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

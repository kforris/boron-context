import type { Evidence } from './contracts.js'

export interface ActivityObservation {
  readonly activityId: string
  readonly asOf: string | null
  readonly subjectUri: string
}

export function markActivityObservation(
  item: Evidence,
  observation: ActivityObservation
): Evidence {
  return {
    ...item,
    excerpt: `[Historical activity observation as of ${observation.asOf ?? 'unknown time'}; not proof of current state.] ${item.excerpt}`,
    metadata: {
      ...item.metadata,
      temporalContext: { role: 'activity_observation', ...observation }
    }
  }
}

// Relate observations to typed current state only by exact subject identity.
// A newer document sharing a URI does not invalidate earlier decisions or facts.
export function linkCurrentStateEvidence(
  evidence: readonly Evidence[],
  currentRelations: readonly Evidence[]
): readonly Evidence[] {
  const states = currentRelations.filter(
    (item) =>
      item.metadata.ontologyKind === 'relation' &&
      item.metadata.confirmationState === 'confirmed' &&
      typeof item.metadata.stateFamily === 'string' &&
      typeof item.metadata.sourceUri === 'string'
  )
  return evidence.map((item) => {
    const temporal = item.metadata.temporalContext as
      (ActivityObservation & { readonly role?: string }) | undefined
    if (temporal?.role !== 'activity_observation') return item
    const current = states.filter(
      (state) =>
        state.metadata.sourceUri === temporal.subjectUri && state.projectId === item.projectId
    )
    if (current.length === 0) return item
    const ambiguous = current.some((state) =>
      current.some(
        (other) =>
          state.metadata.stateFamily === other.metadata.stateFamily &&
          state.metadata.relationType !== other.metadata.relationType
      )
    )
    const corroborating =
      !ambiguous &&
      typeof temporal.asOf === 'string' &&
      item.uri === temporal.subjectUri &&
      item.metadata.sourceAuthority === 'deterministic_source'
        ? current.filter(
            (state) =>
              state.metadata.assertedByActivityId === temporal.activityId &&
              state.metadata.relationAuthority === 'deterministic_source'
          )
        : []
    const corroborated = corroborating.length > 0
    const refs = (corroborated ? corroborating : current).map((state) => ({
      relationId: state.id,
      relationType: state.metadata.relationType,
      stateFamily: state.metadata.stateFamily,
      uri: state.uri
    }))
    return {
      ...item,
      excerpt: corroborated
        ? `[Source observation as of ${temporal.asOf ?? 'unknown time'} supports the current confirmed state: ${refs.map((ref) => ref.relationType).join(', ')}.] ${item.excerpt.replace(/^\[Historical activity observation[^\]]*\] /, '')}`
        : `${item.excerpt} [${ambiguous ? 'Current state is ambiguous: conflicting confirmed relations' : 'For current state, use confirmed relation(s)'}: ${refs.map((ref) => `${ref.relationType} (${ref.uri})`).join(', ')}.]`,
      metadata: {
        ...item.metadata,
        temporalContext: {
          ...temporal,
          role: corroborated ? 'current_state_source' : 'activity_observation',
          currentStateRefs: refs
        }
      }
    }
  })
}

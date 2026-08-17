import type { CapsuleEvidence, ContextMeterEvidenceAudit } from './contracts.js'

export type SourceCoverageStatus =
  'measured' | 'eligible_unmeasured' | 'ineligible' | 'unobservable'

export interface SourceCoverageClassification {
  readonly status: SourceCoverageStatus
  readonly reason: string
}

export interface SourceCoverageEligibility {
  readonly contractVersion: 2
  readonly numerator: number
  readonly eligibleDenominator: number
  readonly ratio: number
  readonly ineligible: number
  readonly unobservable: number
  readonly reasons: {
    readonly eligible: Readonly<Record<string, number>>
    readonly ineligible: Readonly<Record<string, number>>
    readonly unobservable: Readonly<Record<string, number>>
  }
}

export function classifySourceCoverage(
  item: Pick<CapsuleEvidence, 'layer' | 'uri' | 'metadata' | 'retrieval'>
): SourceCoverageClassification {
  const estimate = item.metadata.sourceTokenEstimate
  const measured = typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0
  const sourceSize = sourceSizeMetadata(item.metadata.sourceSize)

  if (measured) {
    return {
      status: 'measured',
      reason:
        item.retrieval.sourceType === 'live'
          ? 'live_source_measured'
          : item.retrieval.sourceType === 'snapshot'
            ? 'snapshot_source_measured'
            : 'recorded_source_measured'
    }
  }
  if (item.retrieval.sourceType === 'live') {
    return { status: 'eligible_unmeasured', reason: 'live_source_size_unavailable' }
  }
  if (item.retrieval.sourceType === 'snapshot') {
    return { status: 'unobservable', reason: 'legacy_snapshot_unknown_size' }
  }
  if (item.metadata.manualCorrection === true) {
    return { status: 'ineligible', reason: 'internal_manual_correction' }
  }
  if (sourceSize?.status === 'not_applicable') {
    return {
      status: 'ineligible',
      reason: sourceSize.reason ?? 'source_size_not_applicable'
    }
  }
  if (
    item.metadata.ontologyKind === 'project' ||
    item.metadata.ontologyKind === 'entity' ||
    item.metadata.ontologyKind === 'relation'
  ) {
    return { status: 'ineligible', reason: 'ontology_derived' }
  }
  if (sourceSize?.status === 'unavailable' && isExternalSourceUri(item.uri)) {
    return {
      status: 'eligible_unmeasured',
      reason: sourceSize.reason ?? 'external_source_size_unavailable'
    }
  }
  if (isPriorActivity(item)) {
    return { status: 'unobservable', reason: 'legacy_unknown_size' }
  }
  if (isExternalSourceUri(item.uri)) {
    return {
      status: 'eligible_unmeasured',
      reason: sourceSize?.reason ?? 'external_source_size_unavailable'
    }
  }
  return { status: 'ineligible', reason: 'ontology_derived' }
}

function sourceSizeMetadata(value: unknown): { status?: string; reason?: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const metadata = value as Record<string, unknown>
  return {
    ...(typeof metadata.status === 'string' ? { status: metadata.status } : {}),
    ...(typeof metadata.reason === 'string' ? { reason: metadata.reason } : {})
  }
}

export function summarizeSourceCoverage(
  evidence: readonly Pick<
    ContextMeterEvidenceAudit,
    'selected' | 'sourceCoverageStatus' | 'sourceCoverageReason'
  >[],
  legacySampleGap = 0
): SourceCoverageEligibility {
  let numerator = 0
  let eligibleUnmeasured = 0
  let ineligible = 0
  let unobservable = Math.max(0, legacySampleGap)
  const reasons = {
    eligible: {} as Record<string, number>,
    ineligible: {} as Record<string, number>,
    unobservable: {} as Record<string, number>
  }
  if (legacySampleGap > 0) {
    reasons.unobservable.legacy_sample_without_audit = legacySampleGap
  }

  for (const item of evidence) {
    if (!item.selected) continue
    if (item.sourceCoverageStatus === 'measured') {
      numerator += 1
      increment(reasons.eligible, item.sourceCoverageReason)
    } else if (item.sourceCoverageStatus === 'eligible_unmeasured') {
      eligibleUnmeasured += 1
      increment(reasons.eligible, item.sourceCoverageReason)
    } else if (item.sourceCoverageStatus === 'ineligible') {
      ineligible += 1
      increment(reasons.ineligible, item.sourceCoverageReason)
    } else {
      unobservable += 1
      increment(reasons.unobservable, item.sourceCoverageReason)
    }
  }

  const eligibleDenominator = numerator + eligibleUnmeasured
  return {
    contractVersion: 2,
    numerator,
    eligibleDenominator,
    ratio: eligibleDenominator > 0 ? numerator / eligibleDenominator : 0,
    ineligible,
    unobservable,
    reasons
  }
}

function isPriorActivity(item: Pick<CapsuleEvidence, 'uri' | 'metadata'>): boolean {
  return typeof item.metadata.activityId === 'string' || item.uri.startsWith('boron://activity/')
}

function isExternalSourceUri(uri: string): boolean {
  return /^(?:https?:\/\/|file:\/\/|github:|gitlab:|bitbucket:)/i.test(uri)
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1
}

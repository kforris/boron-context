ALTER TABLE context_meter_evidence_samples
  ADD COLUMN IF NOT EXISTS source_coverage_status text NOT NULL DEFAULT 'unobservable'
    CHECK (source_coverage_status IN (
      'measured', 'eligible_unmeasured', 'ineligible', 'unobservable'
    )),
  ADD COLUMN IF NOT EXISTS source_coverage_reason text NOT NULL DEFAULT 'legacy_unknown_size';

UPDATE context_meter_evidence_samples
SET
  source_coverage_status = CASE
    WHEN source_token_estimate IS NOT NULL THEN 'measured'
    WHEN adapter_source_type = 'live' THEN 'eligible_unmeasured'
    WHEN adapter_source_type = 'snapshot' THEN 'unobservable'
    WHEN uri LIKE 'boron://activity/%' THEN 'unobservable'
    WHEN uri ~* '^(https?://|file://|github:|gitlab:|bitbucket:)' THEN 'eligible_unmeasured'
    ELSE 'ineligible'
  END,
  source_coverage_reason = CASE
    WHEN source_token_estimate IS NOT NULL AND adapter_source_type = 'live'
      THEN 'live_source_measured'
    WHEN source_token_estimate IS NOT NULL AND adapter_source_type = 'snapshot'
      THEN 'snapshot_source_measured'
    WHEN source_token_estimate IS NOT NULL THEN 'recorded_source_measured'
    WHEN adapter_source_type = 'live' THEN 'live_source_size_unavailable'
    WHEN adapter_source_type = 'snapshot' THEN 'legacy_snapshot_unknown_size'
    WHEN uri LIKE 'boron://activity/%' THEN 'legacy_unknown_size'
    WHEN uri ~* '^(https?://|file://|github:|gitlab:|bitbucket:)'
      THEN 'external_source_size_unavailable'
    ELSE 'ontology_derived'
  END;

CREATE INDEX IF NOT EXISTS context_meter_evidence_coverage_idx
  ON context_meter_evidence_samples (
    meter_sample_id, selected, source_coverage_status, source_coverage_reason
  );

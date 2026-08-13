-- Telemetry eligibility contract v2.
--
-- Existing observations and activities are labelled as contract v1 without changing their
-- semantic payloads. New writes opt into v2 in the application layer. This preserves historical
-- provenance while allowing adoption and writeback denominators to exclude lifecycle-only,
-- read-only, legacy, and unobservable work for explicit reasons.

ALTER TABLE agent_client_observations
  ADD COLUMN IF NOT EXISTS telemetry_contract_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS observed_by_hook boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS observed_by_mcp boolean NOT NULL DEFAULT false;

ALTER TABLE agent_client_observations
  DROP CONSTRAINT IF EXISTS agent_client_observations_telemetry_contract_check;
ALTER TABLE agent_client_observations
  ADD CONSTRAINT agent_client_observations_telemetry_contract_check
  CHECK (telemetry_contract_version BETWEEN 1 AND 32767);

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS telemetry_contract_version smallint NOT NULL DEFAULT 1;

ALTER TABLE activities
  DROP CONSTRAINT IF EXISTS activities_telemetry_contract_check;
ALTER TABLE activities
  ADD CONSTRAINT activities_telemetry_contract_check
  CHECK (telemetry_contract_version BETWEEN 1 AND 32767);

CREATE INDEX IF NOT EXISTS agent_client_observations_contract_time_idx
  ON agent_client_observations (telemetry_contract_version, initialized_at DESC);
CREATE INDEX IF NOT EXISTS activities_contract_time_idx
  ON activities (telemetry_contract_version, occurred_at DESC);

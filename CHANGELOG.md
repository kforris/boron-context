# Changelog

## [0.3.0] - 2026-08-01

This is a pre-alpha local-use release.

### Added

- ontology-first, deterministic Retrieval Plans with sequential policy/codebase/wiki routing;
- project/entity aliases and confirmed retrieval-policy storage;
- evidence-level Context Meter audit samples and a credential-redacted read-only Inspector API;
- separate re-explanation and source-window metrics with explicit source-estimate coverage.

### Changed

- source adapters now report `ontology`, `snapshot`, or `live` truth instead of implying that
  PostgreSQL evidence snapshots are live Codebase Memory/OpenWiki connections;
- the macOS menu-bar meter now exposes both metric families and the latest Retrieval Plan audit.

### Fixed

- `record_activity.occurredAt` now accepts valid ISO 8601 timestamps with explicit timezone
  offsets as well as UTC `Z` timestamps.

### Documentation

- added a bilingual operating manual and a reusable context-engineering methodology derived from
  verified Boron Content operations;
- documented source-truth inspection, high-risk unresolved-state handling, local upgrade, Codex
  plugin reinstall, and installed-runtime verification.

### Upgrade note

- migration `004_retrieval_plan_meter_audit.sql` is additive, but Context Meter HTTP/MCP consumers
  must adopt the version-2 field names; reinstall the Codex plugin and start a new task after the
  daemon upgrade.

All notable changes to Boron Context are documented here.

## [0.2.0] - 2026-07-30

This is a pre-alpha local-use release.

### Added

- durable agent sessions, semantic activities, selected evidence, and verified outcome writeback;
- temporal relation assertions and retractions for activity-derived state;
- deterministic Context Meter metrics for candidate filtering, recovered context, source
  compression, retrieval latency, and Boron-owned LLM use;
- local Codex plugin with sourced Context Capsule retrieval and bounded semantic writeback;
- native macOS `Boron Meter` menu-bar companion with a 15-second local refresh cycle;
- repeatable macOS `launchd` installers for the daemon and menu-bar companion.

### Changed

- moved the independent Boron daemon to loopback port `41635`, separate from Machina;
- expanded PostgreSQL from static ontology storage into an append-only activity and measurement
  ledger;
- documented that Activity is an Ontology primitive rather than a fourth context layer.

### Security and measurement

- the gateway remains loopback-only by default and uses a local bearer token;
- Boron performs no LLM calls in this release;
- estimated human re-entry time and measured token filtering are reported separately.

## [0.1.0] - 2026-07-28

- established the independent Boron Context repository and MIT license;
- added the initial PostgreSQL ontology, Context Capsule contracts, adapters, authenticated gateway,
  deterministic resolver, platform paths, and macOS/Linux CI.

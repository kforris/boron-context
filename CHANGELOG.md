# Changelog

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

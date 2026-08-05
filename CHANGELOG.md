# Changelog

## [0.5.0] - 2026-08-05

### Added

- resumable `CODEX_THREAD_ID` sessions with renewable leases and auditable automatic partial
  closure for abandoned work;
- MCP-initialization adoption observations plus `get_adoption_health` and HTTP metrics;
- live local Codebase Memory `/rpc` and OpenWiki Markdown adapters with real source-size coverage;
- credential-free Git remote project identity and explicit non-destructive project supersession;
- migration `007_agent_continuity_health.sql` for leases, coverage, and confirmed-endpoint repair.

### Changed

- confirmed relations now promote non-rejected endpoint entities and their exact name aliases to
  confirmed, while candidate relations remain candidate;
- noncanonical aliases remain candidate; migration `008_object_alias_confirmation_boundary.sql`
  auditably corrects any broader local `007` backfill without deleting its provenance;
- the context-continuity skill now applies by default to every non-trivial project task and states
  the observable-coverage boundary explicitly.

### Fixed

- live OpenWiki retrieval now requires the resolved project identity to appear in a page or path,
  preventing unrelated project documentation from entering a scoped Context Capsule.
- content-free adoption observations fail open after 500 ms, so telemetry cannot indefinitely
  delay Agent initialization or a context tool result when the local daemon is unresponsive.

## [0.4.0] - 2026-08-02

This is a pre-alpha local-use release.

### Added

- authenticated Boron Content Inspector with a PostgreSQL ontology knowledge graph, the maintained
  Codebase Memory graph, a documentation-style OpenWiki reader, and a human review queue;
- auditable manual corrections that remain separate from source facts, enter the next project
  Context Capsule at highest authority, and can be resolved by a Boron-enabled agent after repair;
- one-time Inspector launch tickets and cookie/CSRF protection without placing the daemon bearer
  token in a browser URL;
- a lifecycle-scoped Codebase Memory graph sidecar that reuses an existing local UI when available
  and otherwise keeps the maintained graph endpoint online with the Boron daemon;
- migration `005_manual_corrections.sql` and MCP tools for listing and resolving human corrections.

### Changed

- the menu-bar meter now uses explicit high-contrast text colors and opens Boron Content directly
  from its top toolbar;
- the menu-bar panel now uses content-driven full height instead of a fixed-height `ScrollView`;
  `Command-plus` / `Command-minus` scale text and window together, `Command-0` resets the zoom, and
  the maximum height is dynamically capped at 70% of the current screen's visible height;
- the Inspector reuses the configurable loopback Codebase Memory graph rather than copying its
  graph into PostgreSQL; Boron still owns zero LLM calls;
- local home-directory paths and Codebase Memory project labels are compacted in the display layer
  without changing canonical identifiers used for retrieval or corrections.

### Documentation

- added a screenshot-backed visual tour and public OpenWiki example describing the three review
  layers and the Agent-mediated manual-correction lifecycle.

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

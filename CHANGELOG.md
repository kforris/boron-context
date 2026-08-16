# Changelog

## Unreleased

## [0.7.6] - 2026-08-16

### Added

- source-window eligibility contract v2 with a measured numerator, eligible denominator,
  ineligible exclusions, unobservable evidence, and auditable reason counts across HTTP, MCP,
  Inspector, context-quality health, and the native menu bar;
- explicit source-size provenance for live Codebase Memory files, local Markdown, and HTTP adapter
  evidence, plus temporary-PostgreSQL fixtures for live, snapshot, ontology-derived, legacy, and
  unavailable-source categories.

### Changed

- ontology-derived evidence no longer dilutes source-window coverage, while legacy unknown-size
  evidence remains labelled rather than rewritten;
- historical mixed source-coverage fields remain available for older clients, but the nested v2
  eligibility contract is authoritative for release-candidate health.

## [0.7.5] - 2026-08-15

### Added

- a versioned, synthetic, secret-free held-out continuity suite with deterministic recall@5, mean
  reciprocal rank, relevant fixture source coverage, wrong-project retrieval/writeback, and stable
  failure-category reporting;
- CI regression gates against both release-candidate minimums and a frozen 0.7.5 baseline that the
  runner cannot update.

### Changed

- evidence explicitly scoped to a different resolved project is excluded before ranking and
  packing;
- activity writeback and the offline suite share the same resolved-project scope guard.

## [0.7.4] - 2026-08-14

### Added

- ontology governance contract v1 with a versioned, machine-readable entity-kind and
  relation-type registry, ownership/source authority, deprecation metadata, and additive legacy
  labels;
- auditable accepted, rejected, and deprecated write decisions with reason counts through HTTP,
  MCP, and the authenticated Inspector;
- temporary-PostgreSQL fixtures for known, unknown, deprecated, candidate, confirmed, retraction,
  manual-correction, cross-project, and legacy-contract boundaries.

### Changed

- activity relation writeback rejects unregistered vocabulary, inference-only confirmation, and
  retraction of a non-active relation before ontology facts are created;
- deprecated registered vocabulary remains compatible but returns explicit governance counts and
  replacement metadata; historical objects and relations remain contract-v0 rows without semantic
  rewrites.

## [0.7.3] - 2026-08-13

### Added

- telemetry eligibility contract v2 with separate adoption and semantic-writeback numerators,
  eligible denominators, exclusions, unobservable Codex tasks, and reason counts;
- contract-version labels for observations and activities, preserving historical payloads while
  keeping legacy implicit records outside the new denominator;
- 7-day and 30-day eligibility cards in the authenticated local Inspector;
- temporary-PostgreSQL fixtures for semantic, lifecycle-only, read-only, legacy implicit, hook,
  MCP-only, and plugin-unobservable categories.

### Changed

- hook and MCP observations now identify their integration source without capturing prompt or
  transcript content;
- `get_adoption_health` and `/v1/metrics/adoption` retain the old top-level mixed fields for
  compatibility, but the v2 nested contract is authoritative for product health.

## [0.7.2] - 2026-08-12

### Added

- operator-approved independent projects in the existing preview/apply registry workflow, with
  exact non-home roots, collision checks, provenance, and idempotent confirmed identities;
- deterministic context-quality health metrics for project resolution, session lifecycle,
  writeback scope, time integrity, source coverage, corrections, and zero Boron-owned LLM calls.
- deterministic Codex plugin payload fingerprints enforced by `npm run check`, preventing changed
  plugin content from silently reusing a stale local cache key.

### Fixed

- activity writes can explicitly verify their intended project against the open session and reject
  unresolved or cross-project targets;
- resuming a leased external session fails closed when the requested project differs from the
  session's persisted project, without rewriting session ownership or reporting the wrong scope;
- activity timestamps more than five minutes ahead of observation time are rejected.
- Codex cache diagnostics now preserve the expected `<marketplace>/<plugin>/<version>` hierarchy
  and no longer classify a manually shortened path as Boron folder drift.

## [0.7.1] - 2026-08-06

### Fixed

- the LAN MR launchd companion now waits through the bounded daemon startup window instead of
  exiting after a single loopback health failure; pairing and user requests are never retried
  implicitly.

## [0.7.0] - 2026-08-06

### Added

- a read-only Spatial Inspector that combines confirmed/candidate Ontology facts with a bounded,
  source-free projection of the live Codebase Memory graph;
- progressive L0 architecture, L1 representative-symbol, and L2 one-hop call-neighborhood views;
- desktop selection plus Quest WebXR controller/pinch input, two-hand scale/rotation, passthrough,
  breadcrumbs, performance telemetry, and a lower-cost Quest rendering mode;
- an optional paired LAN MR service with a certificate-only HTTP bootstrap, HTTPS data surface,
  five-minute single-use pairing codes, client-bound eight-hour sessions, and a strict read-route
  allowlist;
- a loopback-preserving ADB reverse fallback for Quest development;
- deterministic tests for spatial graph bounds, path/source-text omission, TLS pairing, code reuse,
  request limits, host/client boundaries, write rejection, Three.js assets, and launchd arguments.

### Changed

- the local Inspector can issue standard or spatial one-time tickets and serves pinned Three.js
  build assets from the installed dependency instead of a CDN;
- the macOS CLI and launchd generator can install, serve, and inspect the separate LAN MR process;
- public manuals now document Quest setup, progressive graph semantics, gesture controls,
  performance tradeoffs, and the wireless trust boundary.

### Security

- the privileged Boron daemon remains bound to loopback; LAN access is handled by a separate
  process that cannot forward lifecycle, activity, correction, or other semantic writes;
- the Mac CLI and certificate bootstrap expose the same CA SHA-256 fingerprint for required
  out-of-band verification before a Quest trusts the downloaded local CA;
- LAN request bodies are capped at 64 KiB and return `413`; five failed pairing attempts trigger a
  five-minute per-client limit, and a successful exchange immediately rotates the pairing secret.

## [0.6.0] - 2026-08-05

### Added

- plugin-bundled Codex `SessionStart` and `SessionEnd` hooks for automatic project context loading
  and lifecycle closure after the required Codex trust review;
- a project-required bootstrap endpoint that skips broad or unresolved roots instead of creating an
  unscoped automatic session;
- an idempotent client-lifecycle finalizer that closes unfinished work as `partial` without reading
  or storing the Codex transcript;
- hook contract tests covering privacy, bounded context, fail-open behavior, exact-root bootstrap,
  and repeated lifecycle completion;
- migration `009_codex_thread_context_sync.sql` with an append-only, privacy-safe task ownership
  index and current derived state outside the Ontology graph;
- idempotent `SessionStart` history synchronization plus `get_codex_sync_health` and its
  authenticated HTTP metric.

### Changed

- automatic hook context uses only Codex session identity, working directory, and lifecycle source;
  user prompts and transcript paths never enter Boron requests;
- adoption language now covers Boron-observed hook or MCP threads while preserving the explicit
  boundary for agents that never load the plugin;
- historical reconciliation is now a read-only, user-approved plan consumed by Boron at startup;
  it never rewrites Codex private state or requires an exit/restart window.

### Fixed

- Agent lifecycle, observation, activity, and completion mutations now require the daemon bearer;
  an Inspector browser cookie cannot invoke those write paths;
- unknown temporary roots no longer auto-create confirmed projects; bootstrap uses confirmed thread
  ownership, an explicit project hint, or an exact registered root and otherwise fails closed.

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

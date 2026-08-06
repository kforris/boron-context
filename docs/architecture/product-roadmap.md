# Boron Context product roadmap

## Stage 1: macOS-first, headless-first

### 0.1 foundation

- Context Capsule and adapter contracts
- PostgreSQL ontology schema
- authenticated loopback HTTP gateway
- deterministic ranking and token budgets
- macOS and Linux path abstractions
- `launchd` definition generator

### 0.2 context continuity MVP

- versioned MCP surface
- durable intention, activity, outcome, and capsule writeback
- temporal assert/retract relation effects
- auditable Context Meter and MCP summary
- native read-only macOS menu-bar meter
- tested `launchd` installation and restart

### 0.3 ontology-first retrieval audit

- ontology-first deterministic Retrieval Plan
- source-coverage-aware Meter audit and read-only Inspector preview
- project and object aliases plus confirmed retrieval-policy storage
- bilingual operating manual and reusable context-engineering methodology
- timezone-offset activity timestamps

### 0.4 human-review Inspector

- authenticated Ontology, Codebase Memory, and OpenWiki review surfaces
- revisioned pending human corrections
- native menu-bar Content entry point and visual audit
- collision-safe project identity repair

### 0.5 continuity health

- local folder and Git repository discovery
- stable project identity and deduplication
- live Codebase Memory adapter
- live OpenWiki adapter
- leased session resumption and automatic stale closure
- observable MCP-thread adoption coverage
- coherent confirmed relation endpoints
- explicit non-destructive project supersession

### 0.6 invisible Codex continuity

- plugin-bundled, trust-reviewed `SessionStart` and `SessionEnd` hooks
- automatic exact-project Context Capsule injection
- privacy-safe, idempotent task ownership sync at startup
- dedicated thread context index outside the Ontology relationship graph
- fail-closed unknown-root handling without implicit project creation
- privacy boundary: no prompt or transcript capture
- idempotent client-lifecycle partial closure
- hook/MCP adoption convergence on one external session identity

### 0.7 inference and confirmation

- configurable activity-to-relation rules
- derived-state query contracts
- candidate relation review and correction
- replay and projection rebuild tests

### 0.8 macOS lifecycle

- signed installer
- `launchd` install, upgrade, health, and uninstall
- PostgreSQL backup and restore
- OS-managed credential persistence

### 0.9 Linux

- `systemd` lifecycle
- XDG directories
- package or container evaluation
- parity tests for HTTP, MCP, discovery, and backup

## Stage 2: optional application (evaluate at 1.0)

No independent product UI is being developed before the 1.0 evaluation. The existing menu-bar
meter remains a read-only operational companion. Candidate post-1.0 surfaces include:

- source setup;
- ontology and provenance inspection;
- candidate relationship confirmation;
- policy controls;
- health and diagnostics.

The application cannot become required for daemon availability or the source of truth.

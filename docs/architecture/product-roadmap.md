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

### 0.4 local discovery

- local folder and Git repository discovery
- stable project identity and deduplication
- live Codebase Memory adapter
- live OpenWiki adapter
- setup CLI and temporary local web flow
- candidate-relation confirmation

### 0.5 inference and confirmation

- configurable activity-to-relation rules
- derived-state query contracts
- candidate relation review and correction
- replay and projection rebuild tests

### 0.6 macOS lifecycle

- signed installer
- `launchd` install, upgrade, health, and uninstall
- PostgreSQL backup and restore
- OS-managed credential persistence

### 0.7 Linux

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

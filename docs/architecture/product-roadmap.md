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

### 0.3 local discovery

- local folder and Git repository discovery
- stable project identity and deduplication
- live Codebase Memory adapter
- live OpenWiki adapter
- setup CLI and temporary local web flow
- candidate-relation confirmation

### 0.35 inference and confirmation

- configurable activity-to-relation rules
- derived-state query contracts
- candidate relation review and correction
- replay and projection rebuild tests

### 0.4 macOS lifecycle

- signed installer
- `launchd` install, upgrade, health, and uninstall
- PostgreSQL backup and restore
- OS-managed credential persistence

### 0.5 Linux

- `systemd` lifecycle
- XDG directories
- package or container evaluation
- parity tests for HTTP, MCP, discovery, and backup

## Stage 2: optional application

The application is designed from real headless usage. Candidate surfaces include:

- source setup;
- ontology and provenance inspection;
- candidate relationship confirmation;
- policy controls;
- health and diagnostics.

The application cannot become required for daemon availability or the source of truth.

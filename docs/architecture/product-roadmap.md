# Boron Context product roadmap

## Stage 1: macOS-first, headless-first

### 0.1 foundation

- Context Capsule and adapter contracts
- PostgreSQL ontology schema
- authenticated loopback HTTP gateway
- deterministic ranking and token budgets
- macOS and Linux path abstractions
- `launchd` definition generator

### 0.2 local discovery

- local folder and Git repository discovery
- stable project identity and deduplication
- Codebase Memory adapter contract
- candidate-relation confirmation

### 0.3 integration

- versioned MCP surface
- durable intention and capsule writeback
- OpenWiki adapter
- setup CLI and temporary local web flow

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

<div align="center">

<img src="docs/assets/brand/boron-context-icon.png" alt="Boron Context" width="144" />

# Boron Context

**A macOS-first, headless intention and context layer for agentic work**

[![CI](https://github.com/kforris/boron-context/actions/workflows/ci.yml/badge.svg)](https://github.com/kforris/boron-context/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-b7ff4a.svg)](#project-status)

</div>

AI agents are effective when a task is local and explicit. They waste tokens and human time when
they must reconstruct the whole situation from chat history, scattered repositories, Markdown
files, support answers, and decisions that were never formalized.

Boron Context runs behind Codex, Cursor, voice interfaces, or another agent client. It captures the
user's intention, resolves the relevant project and constraints, queries the right context sources,
and returns a small, sourced **Context Capsule** before execution.

It is not another chat interface and it is not another agent runner.

## Why Boron?

Boron has three valence electrons. The product uses that as a structural metaphor for three
independent context layers:

1. **Ontology** — projects, objects, typed relationships, intentions, constraints, policies,
   provenance, and confirmation state.
2. **Codebase Memory** — repositories, symbols, dependencies, routes, call paths, and code-derived
   evidence.
3. **OpenWiki** — recurring questions, operational problems, support knowledge, exceptions,
   decisions, and lessons learned.

Each layer remains authoritative for the facts it understands. Boron Context resolves them into a
bounded capsule instead of copying everything into one undifferentiated knowledge base.

## Runtime model

```text
Codex / Cursor / voice / another agent
                    │
                    ▼
        Local authenticated gateway
                    │
                    ▼
             Intention capture
                    │
                    ▼
        Project and entity resolution
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
   Ontology   Codebase Memory   OpenWiki
       └────────────┼────────────┘
                    ▼
       Evidence ranking + policy filter
                    │
                    ▼
        Bounded, sourced Context Capsule
                    │
                    ▼
           External agent execution
                    │
                    ▼
      Selected evidence and decisions return
```

PostgreSQL is the durable source of truth for confirmed meaning. Automatically discovered semantic
relations remain candidates until a person confirms them.

## Current pre-alpha

This independent repository contains a new headless foundation:

- strict TypeScript contracts for intentions, evidence, and Context Capsules;
- PostgreSQL migrations for projects, objects, relations, evidence, intentions, confirmations, and
  capsules;
- a PostgreSQL ontology adapter;
- HTTP adapters for Codebase Memory and OpenWiki-compatible search services;
- deterministic evidence ranking, deduplication, and token-budget packing;
- a loopback-only authenticated HTTP gateway;
- platform-neutral state paths with macOS and Linux mappings;
- a macOS `launchd` service-definition generator;
- macOS and Linux CI.

The current API is intentionally small:

- `GET /health`
- `POST /v1/context/resolve`

MCP, source discovery, durable writeback, and a setup surface are next-stage work. Interfaces may
change before `1.0`.

## Quick start on macOS

Requirements:

- Apple Silicon macOS;
- Node.js 20.18.1 or newer;
- PostgreSQL 15 or newer.

```bash
git clone https://github.com/kforris/boron-context.git
cd boron-context
npm install

createdb boron_context
export BORON_DATABASE_URL='postgresql://127.0.0.1/boron_context'
npm run db:migrate

npm run build
npm start
```

On first start, Boron Context creates a local authentication token at:

```text
~/Library/Application Support/Boron Context/daemon.token
```

Resolve a context capsule:

```bash
TOKEN="$(tr -d '\n' < "$HOME/Library/Application Support/Boron Context/daemon.token")"

curl -sS http://127.0.0.1:41634/v1/context/resolve \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "objective": "Explain the constraints relevant to this change",
    "projectHint": "boron-context",
    "tokenBudget": 6000,
    "client": "curl"
  }'
```

Generate the initial macOS service definition:

```bash
npm run service:print > dev.boroncontext.daemon.plist
```

Review paths and environment values before installing the plist. Automated installation and
upgrade handling are not yet implemented.

## Context Capsule budget

The default capsule budget is approximately **6,000 tokens**, with a request hard limit of
**16,000 tokens**. Token counts are deterministic estimates, not model-provider billing values.

The resolver ranks evidence using:

- relevance to the objective and constraints;
- authority and confidence;
- project identity match;
- source provenance;
- stable deduplication.

The target is to reduce repeated broad repository reads, not to make the prompt longer.

## Configuration

| Variable                      | Default                                | Purpose                           |
| ----------------------------- | -------------------------------------- | --------------------------------- |
| `BORON_DATABASE_URL`          | `postgresql://127.0.0.1/boron_context` | PostgreSQL connection             |
| `BORON_HOST`                  | `127.0.0.1`                            | Gateway bind host                 |
| `BORON_PORT`                  | `41634`                                | Gateway port                      |
| `BORON_DAEMON_TOKEN`          | generated file                         | Explicit in-memory token override |
| `BORON_TOKEN_FILE`            | platform state path                    | Token file override               |
| `BORON_CODEBASE_MEMORY_URL`   | unset                                  | Codebase Memory search adapter    |
| `BORON_CODEBASE_MEMORY_TOKEN` | unset                                  | Codebase Memory bearer token      |
| `BORON_OPENWIKI_URL`          | unset                                  | OpenWiki search adapter           |
| `BORON_OPENWIKI_TOKEN`        | unset                                  | OpenWiki bearer token             |

The gateway refuses non-loopback bindings unless `BORON_ALLOW_REMOTE=true`. That override is not a
complete remote security design; use it only behind an independently authenticated boundary.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run check
npm audit --omit=dev --audit-level=high
```

See:

- [System design](docs/architecture/system-design.md)
- [Product roadmap](docs/architecture/product-roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Product stages

### Stage 1 — macOS-first, headless-first

Stabilize installation, `launchd`, PostgreSQL, source adapters, MCP/HTTP, Context Capsules, backup,
and confirmation on a MacBook without requiring a permanent GUI.

Linux follows with `systemd` and XDG paths while preserving the same ontology and API contracts.

### Stage 2 — optional independent application

A later application may provide setup, ontology inspection, relationship confirmation, policy
control, and diagnostics. The headless daemon remains independently usable and authoritative.

## Project status

Boron Context is **pre-alpha**. It is suitable for architecture review and local development, not
production deployment with sensitive data.

The next release gates are:

1. versioned MCP and HTTP contracts;
2. local folder, Git, and Codebase Memory discovery;
3. durable intent and capsule writeback;
4. tested macOS service installation, upgrade, and uninstall;
5. reproducible PostgreSQL backup and restore;
6. Linux `systemd` packaging.

## Independence and inspiration

Boron Context is a new project with its own repository, implementation, history, governance, and
product scope. It is not a fork of Machina and is not affiliated with that project.

Some of its product questions were inspired by earlier experiments around Machina, but no Machina
source history or application code is included. The direction was also informed by Palantir's
public Ontology concepts. Boron Context applies those lessons to an open, local-first context layer
for individuals and small teams.

## License

[MIT](LICENSE)

<div align="center">

<img src="docs/assets/brand/boron-context-icon.png" alt="Boron Context" width="144" />

# Boron Context

**A macOS-first, headless intention and context layer for agentic work**

[![CI](https://github.com/kforris/boron-context/actions/workflows/ci.yml/badge.svg)](https://github.com/kforris/boron-context/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-b7ff4a.svg)](#project-status)
[![Version: 0.2.0](https://img.shields.io/badge/version-0.2.0-6ebb50.svg)](CHANGELOG.md)

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
   semantic activities, derived state, provenance, and confirmation state.
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
      Semantic activities and decisions return
```

PostgreSQL is the durable source of truth for confirmed meaning. Automatically discovered semantic
relations remain candidates until a person confirms them.

Activity is not a fourth context layer. It is a first-class Ontology primitive. Boron records
events and relation effects, then derives current state from active relations instead of requiring
agents to maintain duplicated status prose.

## Current pre-alpha

This independent repository contains a new headless foundation:

- strict TypeScript contracts for intentions, evidence, and Context Capsules;
- PostgreSQL migrations for projects, objects, relations, evidence, intentions, confirmations, and
  capsules;
- append-only agent sessions and semantic activities with temporal assert/retract relation effects;
- an auditable Context Meter separating measured retrieval, deterministic token estimates, and
  unobserved counterfactual savings;
- a PostgreSQL ontology adapter;
- HTTP adapters for Codebase Memory and OpenWiki-compatible search services;
- deterministic evidence ranking, deduplication, and token-budget packing;
- a loopback-only authenticated HTTP gateway;
- platform-neutral state paths with macOS and Linux mappings;
- a versioned local MCP surface and Codex plugin;
- a macOS `launchd` service-definition generator;
- an optional native macOS menu-bar meter for live context efficiency and daemon health;
- macOS and Linux CI.

The current API is intentionally small:

- `GET /health`
- `POST /v1/context/resolve`
- `POST /v1/sessions/start`
- `POST /v1/activity/record`
- `POST /v1/sessions/complete`
- `POST /v1/metrics/context`

Source discovery, generic inference rules, confirmation UI, and a setup surface remain next-stage
work. Interfaces may change before `1.0`.

## Quick start on macOS

Requirements:

- Apple Silicon macOS;
- Node.js 20.19.0 or newer;
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

curl -sS http://127.0.0.1:41635/v1/context/resolve \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "objective": "Explain the constraints relevant to this change",
    "projectHint": "boron-context",
    "tokenBudget": 6000,
    "client": "curl"
  }'
```

Install and start the macOS background service:

```bash
npm run service:install
```

The generated LaunchAgent is independent from Machina and keeps the Boron daemon alive across
logins and process failures.

## Codex plugin MVP

The repository includes a local Codex plugin under `plugins/boron-context`. It provides:

- `begin_context_session` to retrieve a project capsule and open an episode;
- `record_activity` to store selected semantic milestones and relation effects;
- `complete_context_session` to preserve verified outcomes and decisions;
- `query_context` for read-only context retrieval.
- `get_context_meter` to inspect context reuse, filtering, source compression, latency, and
  Boron-owned LLM usage.

The companion skill asks Codex to read before substantive project work and write back after
verification. It deliberately does not capture raw transcripts or every tool call.

Install the repository marketplace and plugin:

```bash
codex plugin marketplace add .
codex plugin add boron-context@boron-context
```

Start a new Codex task after installation so the MCP tools and skill are loaded.

## Context Meter

Every generated capsule contains a deterministic meter:

- candidate and selected evidence counts;
- candidate, capsule, and filtered token estimates;
- context recovered from prior Boron activities;
- source-to-excerpt compression when the source supplies `sourceTokenEstimate`;
- retrieval latency;
- LLM calls and tokens owned by Boron.

The current token estimator is `characters / 4`. It is deterministic and useful for comparing
Boron runs, but it is not a provider invoice.

Query a 30-day project summary through MCP with `get_context_meter`, or through HTTP:

```bash
curl -sS http://127.0.0.1:41635/v1/metrics/context \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectHint":"Boron Context","windowDays":30}'
```

The meter does not claim a counterfactual it cannot observe. `recoveredContextTokens` approximate
context the user did not need to retype, but those compact tokens still enter the agent model.
Actual context-window savings against a repository or document are reported only when the evidence
has an original source-token estimate.

### Current LLM use

Boron Context currently calls **no LLM**. PostgreSQL full-text search, deterministic ranking,
deduplication, and budget packing build the capsule. Codex or another client writes selected
semantic summaries during its existing turn, so Boron has no separate model provider, model bill,
or hidden inference call.

Future autonomous extraction may use a client-supplied model, a local model, or an explicitly
configured cloud model. Any such use must appear separately in the meter.

## macOS menu-bar meter

`Boron Meter` is an optional native SwiftUI companion. It stays beside utilities such as Stats,
GPT, or MTMR in the macOS menu bar while the headless daemon remains the source of truth.

The compact menu item shows the current candidate-context reduction. Clicking it opens a local
panel with:

- candidate, capsule, and filtered token estimates;
- recovered context and estimated manual re-entry equivalent;
- source-to-excerpt compression where source estimates exist;
- retrieval latency, healthy layers, and Boron-owned LLM calls;
- daemon and PostgreSQL health.

It polls `127.0.0.1:41635` every 15 seconds and reads the existing local daemon token. It sends no
telemetry and adds no LLM calls or cloud cost.

Build, install to `~/Applications/Boron Meter.app`, and keep it available at login:

```bash
python3 scripts/install_menubar.py
```

The app requires macOS 14 or newer and a running Boron Context daemon.

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
| `BORON_PORT`                  | `41635`                                | Gateway port                      |
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
- [Changelog](CHANGELOG.md)

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

1. local folder, Git, and Codebase Memory discovery;
2. configurable activity-to-relation inference rules;
3. candidate confirmation and correction workflow;
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

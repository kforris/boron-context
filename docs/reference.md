# Boron Context reference

This page keeps operational detail out of the project homepage while preserving a compact reference
for the local API, configuration, evidence labels, and Codex plugin tools.

## Authentication

The gateway binds to `127.0.0.1:41635` by default. On first start it creates a bearer token at:

```text
~/Library/Application Support/Boron Context/daemon.token
```

Every endpoint except `GET /health` and the initial Inspector shell requires either that bearer or
an Inspector session with the route's required scope. Agent lifecycle and activity mutations always
require the daemon bearer.

## HTTP API

### Health and context

- `GET /health`
- `POST /v1/context/resolve`
- `POST /v1/metrics/context`
- `POST /v1/metrics/context/inspect`
- `POST /v1/metrics/adoption`
- `POST /v1/metrics/codex-sync`

### Agent lifecycle

- `POST /v1/sessions/start`
- `POST /v1/sessions/bootstrap`
- `POST /v1/activity/record`
- `POST /v1/sessions/complete`
- `POST /v1/sessions/lifecycle-end`
- `POST /v1/clients/observe`
- `POST /v1/imports/codex-threads`

### Inspector

- `GET /inspector`
- `POST /v1/inspector/ticket`
- `POST /v1/inspector/session`
- `POST /v1/inspector/ontology`
- `POST /v1/inspector/wiki`
- `POST /v1/inspector/corrections/list`
- `POST /v1/inspector/corrections/create`
- `POST /v1/inspector/corrections/resolve`

Resolve a capsule directly:

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

## Codex plugin tools

| Tool                        | Purpose                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `begin_context_session`     | Retrieve a project capsule and open or resume a durable session.                            |
| `query_context`             | Retrieve a read-only capsule without opening a writeback session.                           |
| `record_activity`           | Store a selected semantic milestone and optional relationship effects.                      |
| `complete_context_session`  | Close a session with its verified outcome and durable decisions.                            |
| `get_context_meter`         | Summarize context reuse, filtering, source compression, latency, and Boron-owned model use. |
| `inspect_context_meter`     | Inspect recent Retrieval Plans and evidence-level metric composition.                       |
| `get_adoption_health`       | Measure coverage among hook- or MCP-observed agent tasks.                                   |
| `get_codex_sync_health`     | Inspect privacy-safe historical task ownership synchronization.                             |
| `list_manual_corrections`   | Read human-authored review requests from Boron Content.                                     |
| `resolve_manual_correction` | Resolve or dismiss a request after evidence-backed review.                                  |

The context-continuity skill reuses an automatically injected session when present. It records
semantic turning points, not every tool call or raw conversation content.

## Configuration

| Variable                          | Default                                | Purpose                                       |
| --------------------------------- | -------------------------------------- | --------------------------------------------- |
| `BORON_DATABASE_URL`              | `postgresql://127.0.0.1/boron_context` | PostgreSQL connection                         |
| `BORON_HOST`                      | `127.0.0.1`                            | Gateway bind host                             |
| `BORON_PORT`                      | `41635`                                | Gateway port                                  |
| `BORON_DAEMON_TOKEN`              | generated file                         | Explicit in-memory token override             |
| `BORON_TOKEN_FILE`                | platform state path                    | Token file override                           |
| `BORON_OPENWIKI_ROOT`             | `~/.openwiki/wiki`                     | Local Markdown Wiki root                      |
| `BORON_CODEBASE_MEMORY_GRAPH_URL` | `http://127.0.0.1:9749`                | Codebase graph UI and RPC endpoint            |
| `BORON_CODEBASE_MEMORY_COMMAND`   | `~/.local/bin/codebase-memory-mcp`     | Optional graph sidecar command                |
| `BORON_SESSION_SWEEP_INTERVAL_MS` | `300000`                               | Expired-session sweep interval                |
| `BORON_CODEBASE_MEMORY_URL`       | unset                                  | Compatible authenticated code search endpoint |
| `BORON_CODEBASE_MEMORY_TOKEN`     | unset                                  | Code search bearer token                      |
| `BORON_OPENWIKI_URL`              | unset                                  | Compatible authenticated Wiki search endpoint |
| `BORON_OPENWIKI_TOKEN`            | unset                                  | Wiki search bearer token                      |

The gateway rejects non-loopback bindings unless `BORON_ALLOW_REMOTE=true`. That override is not a
complete remote security design; place remote access behind an independently authenticated boundary.

## Source truth labels

| Source type | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `ontology`  | Live PostgreSQL Ontology used for deterministic location and policy.          |
| `snapshot`  | Evidence stored in PostgreSQL; it does not prove the external source is live. |
| `live`      | A configured local or HTTP source was queried in this request.                |

The default local installation queries the maintained Codebase Memory RPC endpoint and configured
Markdown Wiki directly, then uses labeled PostgreSQL evidence snapshots as fallback.

## Context budgets and metrics

The default capsule budget is approximately 6,000 estimated tokens; the request hard limit is
16,000. The deterministic estimator uses `characters / 4`, so metrics are suitable for comparing
Boron runs but are not provider invoices.

`reExplanation.avoidedTokens` measures verified prior-context excerpts the user or agent did not
need to re-enter. Those compact excerpts still enter the client model. `sourceWindow.savingsTokens`
is reported only for evidence with a real `sourceTokenEstimate`, always alongside coverage.

See the [operating manual](operating-manual.md) for interpretation and the
[system design](architecture/system-design.md) for the underlying retrieval contract.

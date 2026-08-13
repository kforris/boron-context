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
- `POST /v1/metrics/context/quality`
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
- `GET /inspector/spatial`
- `POST /v1/inspector/ticket`
- `POST /v1/inspector/session`
- `POST /v1/inspector/ontology`
- `POST /v1/inspector/codebase-spatial`
- `POST /v1/inspector/codebase-spatial-expand`
- `POST /v1/inspector/wiki`
- `POST /v1/inspector/corrections/list`
- `POST /v1/inspector/corrections/create`
- `POST /v1/inspector/corrections/resolve`

Pass `{"mode":"spatial"}` to the ticket endpoint to issue a one-time URL for the read-only WebXR
Inspector. `codebase-spatial` returns a bounded `architecture_clusters_lod_v2` projection from the
live Codebase Memory graph. The client reveals it progressively: project and architecture clusters
(L0), representative symbols for one selected cluster (L1), then a separately queried, deterministic
one-hop call neighborhood (L2). `codebase-spatial-expand` accepts `project` and `symbol`, caps callers
and callees at 12 each, and returns names and typed derived edges—not source text or file paths.

The optional LAN MR service is a separate HTTPS process. Its public HTTP bootstrap exposes only
minimal health, the local CA certificate, and its SHA-256 fingerprint. Compare that fingerprint
with the value printed directly by `boron-context lan-inspector pair` before installing the CA;
stop if they differ. After one-time pairing, the HTTPS service whitelists
only `/inspector/spatial`, the local Three.js assets, `/v1/inspector/ontology`, and
`/v1/inspector/codebase-spatial` plus its read-only `-expand` route; every other `/v1/` route fails
closed. Install it with
`boron-context lan-inspector install` and print a fresh pairing code with
`boron-context lan-inspector pair`.

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

| Tool                         | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `begin_context_session`      | Retrieve a project capsule and open or resume a durable session.                            |
| `query_context`              | Retrieve a read-only capsule without opening a writeback session.                           |
| `record_activity`            | Store a milestone after verifying its target project against the open session.              |
| `complete_context_session`   | Close a session with its verified outcome and durable decisions.                            |
| `get_context_meter`          | Summarize context reuse, filtering, source compression, latency, and Boron-owned model use. |
| `inspect_context_meter`      | Inspect recent Retrieval Plans and evidence-level metric composition.                       |
| `get_context_quality_health` | Audit project scope, lifecycle, time integrity, source coverage, and corrections.           |
| `get_adoption_health`        | Audit v2 adoption/writeback eligibility, exclusions, reasons, and observability boundaries. |
| `get_codex_sync_health`      | Inspect privacy-safe historical task ownership synchronization.                             |
| `list_manual_corrections`    | Read human-authored review requests from Boron Content.                                     |
| `resolve_manual_correction`  | Resolve or dismiss a request after evidence-backed review.                                  |

The context-continuity skill reuses an automatically injected session when present. It records
semantic turning points, not every tool call or raw conversation content.

## Configuration

| Variable                          | Default                                | Purpose                                        |
| --------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `BORON_DATABASE_URL`              | `postgresql://127.0.0.1/boron_context` | PostgreSQL connection                          |
| `BORON_HOST`                      | `127.0.0.1`                            | Gateway bind host                              |
| `BORON_PORT`                      | `41635`                                | Gateway port                                   |
| `BORON_DAEMON_TOKEN`              | generated file                         | Explicit in-memory token override              |
| `BORON_TOKEN_FILE`                | platform state path                    | Token file override                            |
| `BORON_OPENWIKI_ROOT`             | `~/.openwiki/wiki`                     | Local Markdown Wiki root                       |
| `BORON_CODEBASE_MEMORY_GRAPH_URL` | `http://127.0.0.1:9749`                | Codebase graph UI and RPC endpoint             |
| `BORON_CODEBASE_MEMORY_COMMAND`   | `~/.local/bin/codebase-memory-mcp`     | Optional graph sidecar command                 |
| `BORON_SESSION_SWEEP_INTERVAL_MS` | `300000`                               | Expired-session sweep interval                 |
| `BORON_CODEBASE_MEMORY_URL`       | unset                                  | Compatible authenticated code search endpoint  |
| `BORON_CODEBASE_MEMORY_TOKEN`     | unset                                  | Code search bearer token                       |
| `BORON_OPENWIKI_URL`              | unset                                  | Compatible authenticated Wiki search endpoint  |
| `BORON_OPENWIKI_TOKEN`            | unset                                  | Wiki search bearer token                       |
| `BORON_ADB`                       | `adb`                                  | Quest Inspector ADB executable override        |
| `BORON_LAN_MR_HOST`               | detected private IPv4                  | Exact LAN address for the read-only MR service |
| `BORON_LAN_MR_HOSTNAME`           | macOS local hostname                   | Optional Bonjour hostname in the TLS SAN       |
| `BORON_LAN_MR_BOOTSTRAP_PORT`     | `41636`                                | Certificate-only HTTP bootstrap port           |
| `BORON_LAN_MR_PORT`               | `41637`                                | Paired read-only HTTPS Inspector port          |
| `BORON_LAN_MR_STATE_DIR`          | platform state path + `/lan-mr`        | CA, server certificate, and pairing secrets    |
| `BORON_OPENSSL`                   | `/usr/bin/openssl`                     | Local certificate generator executable         |

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

`get_context_quality_health` deliberately returns separate deterministic indicators rather than a
single intelligence score. It reports project resolution, session lifecycle, explicit versus
legacy implicit writeback scope, timestamps more than five minutes ahead of observation, source
coverage, and current manual corrections. These fields audit continuity quality; they do not prove
that an agent's semantic judgment improved.

`get_adoption_health` returns `contractVersion: 2`. Its `adoption` and `writeback` objects each
contain `numerator`, `eligibleDenominator`, `ratio`, `ineligible`, and reason maps. Adoption also
contains `unobservable` plus `plugin_not_observed`; read-only context is adoption-eligible but not
writeback-eligible. Lifecycle/intent and contract-v1 legacy records are excluded for explicit
reasons. The historical top-level coverage fields are unchanged for older clients but must not be
reported as eligible adoption.

See the [operating manual](operating-manual.md) for interpretation and the
[system design](architecture/system-design.md) for the underlying retrieval contract.

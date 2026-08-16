# Boron Context system design

## Product boundary

Boron Context is a headless intention and context layer. Agent clients own input, conversation,
execution, and presentation. Boron Context owns the resolution of project meaning, relevant
evidence, constraints, provenance, and confirmation state.

## Principles

1. Headless-first.
2. macOS-first, platform-neutral.
3. PostgreSQL stores durable confirmed meaning.
4. Source systems remain authoritative for their native facts.
5. Inference is a candidate, not truth.
6. Context responses are bounded and attributable.
7. Execution stays external.
8. A future application remains optional.

## Three context layers

| Layer           | Authority                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Ontology        | Projects, objects, activities, typed relations, derived state, policy, provenance, confirmation |
| Codebase Memory | Repositories, files, symbols, dependencies, routes, call paths, code versions                   |
| OpenWiki        | Explanations, recurring questions, incidents, exceptions, decisions, operational lessons        |

## Request lifecycle

```mermaid
flowchart TD
    C["Agent client"] --> G["Authenticated loopback gateway"]
    G --> I["Intention capture"]
    I --> R["Project and entity resolver"]
    R --> O["Ontology location / PostgreSQL"]
    O --> H{"High-risk intent?"}
    H -->|Yes| Y["Confirmed policy stage"]
    H -->|No| Q["Deterministic Retrieval Plan"]
    Y --> Q
    Q -->|Code signal / anchor| M["Codebase adapter"]
    Q -->|Wiki / continuity signal| W["OpenWiki adapter"]
    O --> F["Evidence ranking and policy filter"]
    M --> F
    W --> F
    F --> P["Bounded Context Capsule"]
    P --> C
    C --> E["External agent execution"]
    E --> B["Selected result writeback"]
    B --> H{"Semantic change?"}
    H -->|No| O
    H -->|Yes| X["Human confirmation"]
    X --> O
```

1. A client submits an objective and optional project hints.
2. The gateway authenticates the local client and assigns a trace ID.
3. Stable paths and source identifiers resolve the project before natural-language similarity.
4. PostgreSQL supplies confirmed ontology and policy.
5. A deterministic planner records request signals and selects only the required later stages.
6. Weak, stale, unauthorized, or redundant evidence is removed.
7. The resolver returns a capsule within the requested token budget.
8. The external agent executes with its own tools and permissions.
9. Selected activities, evidence, and decisions return as append-only events.
10. Event effects assert or retract temporal relations; current state is derived from active links.
11. Durable model-inferred semantic changes remain candidates until confirmation.

## Context Meter

Each capsule reports deterministic metrics and stores both an aggregate sample and candidate-level
audit rows in PostgreSQL:

| Metric                       | Meaning                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `capsuleTokens`              | Estimated tokens actually returned by Boron                           |
| `filteredTokens`             | Candidate excerpt tokens omitted by ranking and budget packing        |
| `reExplanationAvoidedTokens` | Selected tokens originating from earlier verified Boron activities    |
| `sourceWindowSavingsTokens`  | Original-source estimate minus capsule excerpt, for covered evidence  |
| `sourceWindowCoverageRatio`  | Selected evidence with a real source estimate divided by all selected |
| `sourceWindow.eligibility`   | Measured numerator divided by eligible source-window evidence         |
| `retrievalLatencyMs`         | Time spent resolving and packing the capsule                          |
| `boronLlm.calls`             | LLM calls performed and owned by Boron; currently always zero         |

Token estimates use characters divided by four. `capsuleTokens` covers the serialized capsule,
including provenance, Retrieval Plan, and Meter fields; evidence-level capsule tokens include their
serialized provenance wrapper. Manual re-entry time is presented only as an equivalent at a stated
typing speed. It is not observed human time. Source-window reduction remains `null`/not covered
unless ingestion provides `sourceTokenEstimate`; partial aggregates exclude uncovered evidence and
report coverage beside the result.

Eligibility contract v2 classifies each selected audit row as `measured`,
`eligible_unmeasured`, `ineligible`, or `unobservable`. Live or external sources with an
unavailable size stay in the denominator; ontology-derived facts are excluded; and legacy
unknown-size activity/snapshot rows remain unobservable. Historical mixed fields are preserved for
wire compatibility but are not release-candidate evidence.

## Retrieval planning and adapter truth

The planner is ontology-first and source-aware. It does not own an LLM or embedding call. Stable
paths, source URIs, explicit titles, symbols, project/entity aliases, and risk signals are evaluated
with deterministic rules. Ontology always runs first; policy runs next for high-risk intent; then
Codebase and Wiki stages run sequentially only when their signals or explicit layer constraints
require them.

Adapters report `sourceType`:

- `ontology`: live PostgreSQL Ontology;
- `snapshot`: selected Codebase/Wiki evidence already stored in PostgreSQL;
- `live`: a configured external HTTP source queried during that stage.

The current runtime ships PostgreSQL Ontology and snapshot adapters. Codebase Memory and OpenWiki
are not live integrations unless their respective URLs are configured and healthy.

## Activity and derived state

Activity is an Ontology primitive rather than a fourth context layer. An activity records what
happened, when it happened, who or what participated, and the source evidence. Relation effects
change the valid-time interval of typed links.

```text
Activity: A LEFT B
Effect: retract A OCCUPIES B at t
Derived query: B is empty when no active OCCUPIES links remain at t
```

The durable source is the event and relation-effect history. Frequently requested current state may
be materialized for latency, but it must remain reproducible from that history. Incomplete or
conflicting evidence yields `unknown`, not an invented Boolean state.

## Context Capsule

A capsule contains:

- objective and trace ID;
- resolved project identity;
- explicit constraints;
- ranked evidence with layer, URI, confidence, authority, and source version;
- unresolved assumptions;
- estimated token use and truncation state.

The default target is 6,000 estimated tokens. Requests are capped at 16,000.

## Storage

PostgreSQL stores:

- sources and source snapshots;
- projects and objects;
- typed relations and revisions;
- intentions and confirmation requests;
- evidence references and hashes;
- generated Context Capsules;
- Retrieval Plans and evidence-level Context Meter audit samples;
- agent sessions, semantic activities, and temporal relation effects;
- policies and authorization decisions as the system matures.

Code graphs and Wiki bodies remain in their owning systems. PostgreSQL stores stable references and
selected excerpts, not wholesale copies.

## Platform architecture

### macOS

- Apple Silicon first;
- `launchd` background service;
- Application Support and Library Logs directories;
- generated local bearer token with mode `0600`;
- local PostgreSQL or an explicitly configured server.

The optional Quest LAN MR process is a separate trust boundary. It binds an explicit private IPv4,
terminates TLS with a device-installed local CA, consumes a five-minute pairing code once, and
exposes only the read-only spatial shell plus Ontology and bounded Codebase projection routes. It
does not widen the daemon's loopback listener or forward lifecycle, activity, or correction writes.
Because the CA download uses a certificate-only HTTP bootstrap, the CLI and bootstrap surface expose
the same SHA-256 fingerprint for mandatory out-of-band comparison before device trust is granted.
The Codebase projection uses progressive disclosure: the initial architecture payload includes
cluster membership and representative symbols, while a separate bounded read fetches at most one
hop of callers and callees for the symbol a user explicitly opens.

### Linux

- same daemon, schema, adapters, and HTTP/MCP contracts;
- `systemd` service adapter;
- XDG configuration and state paths;
- equivalent loopback authentication and filesystem boundaries.

Platform behavior stays behind adapters. The ontology and capsule formats do not branch by OS.

## Target modules

```text
src/
  core/       contracts, ranking, capsule construction
  adapters/   Codebase Memory, OpenWiki, future sources
  db/         PostgreSQL migrations and ontology repository
  gateway/    local HTTP transport
  plugin/     Codex skill and MCP transport
  platform/   macOS and Linux lifecycle and paths
```

## Security invariants

- Loopback binding is the default.
- Remote access requires an explicit override and an external security boundary.
- Requests have bounded bodies and bounded output budgets.
- Credentials never enter capsules.
- Source and project authorization is checked before evidence delivery.
- A model cannot silently confirm its own semantic inference.

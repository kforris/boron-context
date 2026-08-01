# Context-engineering methodology

[简体中文](context-engineering-methodology.zh-CN.md)

This methodology turns durable agent context into a reviewable data and process system. It was
refined through project continuity work and the bounded, approval-first Boron Content workflow.

## The operating loop

```text
Intention -> Ontology locate -> Risk/policy check -> Narrow source expansion
          -> Agent execution -> Verification -> Semantic milestone writeback
```

1. **Capture intention.** Keep the user's objective, project, scope, and constraints distinct from
   retrieved evidence.
2. **Locate before searching.** Resolve project identity, aliases, entities, current relations,
   source anchors, and policy references in Ontology first.
3. **Gate risk.** Retrieve confirmed policy before later source expansion for high-risk intent.
   Missing policy becomes an unresolved client gate, not implied permission.
4. **Expand narrowly.** Select Codebase for symbols and implementation; select Wiki for decisions,
   explanations, and continuity. Prefer a configured live adapter and label snapshot fallback.
5. **Execute outside Boron.** The agent uses its own tools, permissions, and current verification.
6. **Write semantic deltas.** Persist decisions, verified outcomes, corrections, and relation
   changes—not the whole process transcript.

## Five design invariants

1. **Source truth is typed.** Ontology, live external sources, and stored snapshots are not
   interchangeable.
2. **Confirmation is explicit.** Human or deterministic authoritative facts may be confirmed;
   inference remains candidate.
3. **State changes are temporal.** Assert and retract relations rather than accumulating duplicate
   status prose.
4. **Action permission is external.** Context retrieval never grants deployment, publishing,
   credential, payment, deletion, or other mutation authority.
5. **Measurement names its counterfactual.** Re-explanation reuse and source-window savings are
   different metrics and require different evidence.

## Bounded-unit pattern

For repeatable workflows, model one run as:

```text
one authorized trigger
one selected project
one primary work unit
one explicit approval/policy boundary
one verified outcome
one completed Boron session
```

Stable event IDs and idempotency keys make retries safe. `no_material_change`, `blocked`, and
`inconclusive` are valid outcomes; manufacturing activity to create a positive result corrupts the
context ledger.

## Agent and human split

| Agent-suitable                              | Human or external-policy decision                   |
| ------------------------------------------- | --------------------------------------------------- |
| Resolve bounded context and provenance      | Confirm ambiguous project identity                  |
| Detect stale/conflicting evidence           | Approve high-risk actions or policy exceptions      |
| Run tests and collect deterministic results | Supply credentials or make irreversible commitments |
| Propose candidate relations                 | Confirm inferred relationships                      |
| Record redacted semantic milestones         | Decide whether sensitive evidence may be retained   |

## Measurement discipline

- Use capsule and candidate token estimates to compare Boron runs, not as provider invoices.
- Report source savings only for evidence with an actual source-size estimate.
- Always show source coverage beside partial savings.
- Report Boron-owned model usage separately from the client agent's existing model turn.
- Use the Inspector to audit stage order, adapter truth, selection, score, and coverage without
  exposing excerpts or credentials.

## Adoption checklist

- Define stable project and object URIs.
- Define which system owns each fact and large asset.
- Define candidate-to-confirmed authority.
- Define high-risk policy gates and valid blocked outcomes.
- Define the small set of semantic activity types worth retaining.
- Define relation assertions and retractions for changing state.
- Configure live adapters only where current source access is required.
- Test cold start, retry idempotency, partial failure, redaction, migration, and installed-artifact
  behavior.

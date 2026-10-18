# Trusted-continuity weekly review — 2026-10-18

This review covers the 2026-10-12 through 2026-10-18 Toronto operating window. It summarizes
public-safe aggregates only. Raw GitHub Traffic responses, task evidence, credentials, and user
assets remain outside the repository.

## Product evidence

| Evidence                                              | Weekly result                  | Acceptance effect    |
| ----------------------------------------------------- | ------------------------------ | -------------------- |
| Naturally occurring tasks retained                    | 1 content-production candidate | Pending, not counted |
| Qualifying Issue #24 cases                            | 0/15                           | `NO-GO`              |
| Separate independent reviews                          | 0                              | `NO-GO`              |
| Operator-visible first Capsule plus second-task reuse | Not completed                  | Still required       |

The retained candidate has a verified concrete output, but its task receipt does not establish an
exact task-to-Capsule binding, a task-specific context-use disposition, per-task omission/staleness/
repeat-retrieval/correction/token observations, or a separate reviewer decision. Missing fields
remain `unknown`; no telemetry or lifecycle receipt was promoted into independent benefit evidence.

## Installation and trial readiness

- The isolated Apple Silicon lifecycle rehearsal passed 30/30 recorded steps for a current clean
  install/uninstall, v0.7.8-to-v0.9.0 upgrade, backup/restore into an empty database, rollback, and
  final uninstall with durable data retained. Its receipt records that the production database was
  not touched.
- This automated rehearsal verifies the engineering lifecycle. It does not replace a voluntary,
  operator-visible first Capsule, a separate second-task continuation, or independent review.
- A bounded 3–5-person opt-in trial guide, disposable fixture, redaction-first support checklist,
  and anonymous feedback template are ready. No participant was contacted, invited, counted, or
  inferred from repository traffic.

## Current release-candidate gates

The measurements below were read on 2026-10-18 at the start of the scheduled run. Each gate remains
independent; they are not averaged into one score.

| Gate                            | Current evidence                                                    | Result                            |
| ------------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| Known P0/P1                     | 0 labeled P0/P1 among current open GitHub issues                    | Pass within that observed surface |
| Wrong-project behavior          | Held-out retrieval/writeback 0/0; production-shaped retrieval 0     | Pass                              |
| 7-day eligible adoption         | 123/142 = 86.62%                                                    | Pass                              |
| 30-day eligible adoption        | 550/634 = 86.75%                                                    | Pass                              |
| Held-out recall@5               | 1.00 against frozen 1.00 baseline                                   | Pass                              |
| 7-day retrieval latency         | average / linear p95 / max = 152.67 / 382.30 / 566 ms, 12 samples   | **Fail**                          |
| 30-day retrieval latency        | average / linear p95 / max = 189.92 / 301.65 / 2,843 ms, 38 samples | **Fail**                          |
| 7-day eligible source coverage  | 24/24 = 100%; 7 ineligible, 11 unobservable                         | Pass                              |
| 30-day eligible source coverage | 66/66 = 100%; 29 ineligible, 74 unobservable                        | Pass                              |
| Pending manual corrections      | 0                                                                   | Pass                              |
| Boron-owned online LLM calls    | 0                                                                   | Pass                              |

The historical mixed source-coverage ratios are 24/42 and 66/169. They are not the release gate:
ontology-derived evidence is ineligible, and legacy evidence without observed source size is
unobservable. Signed measured source-window differences are +86,579 tokens over 7 days and +151,682
over 30 days; these are partial source-minus-excerpt measurements, not downstream billing savings.

Compared with the 2026-10-12 snapshot, 7-day p95 improved from 479.25 ms to 382.30 ms but remains
above 250 ms. The 30-day p95 moved from 246.00 ms to 301.65 ms as the rolling sample set changed and
now also fails. No synthetic query, retained-sample deletion, or historical rewrite was used to
improve either window.

## GitHub Traffic boundary

The private 2026-10-18 snapshot returned all four Traffic endpoints successfully for GitHub's
rolling 14-day window:

- views / unique views: 3 / 1;
- clones / unique clones: 206 / 67;
- one referrer row and two popular-path rows;
- stars / forks: 0 / 0.

The daily clone aggregates observed from 2026-10-12 through 2026-10-18 were 65, 55, 78, 121, 146,
168, and 206. These overlapping rolling windows cannot be summed. Clones and unique clones do not
establish people, installations, active users, successful task continuation, or a retained
same-method historical peak. This review therefore makes no traffic-record claim.

## Version and delivery state

- Repository `main`, local `main`, `origin/main`, and remote `main` agreed at
  `bd0086bbb77311148e5efeaf55c887c8b43cd5a0` when this review began; its final-main CI passed 6/6.
- Source and daemon report 0.9.0; the enabled Codex plugin reports
  `0.9.0+codex.c8386a2d706e`; the installed menu is 0.9.0 build 17 and matches the local release
  binary. Runtime PostgreSQL and all six adapters are healthy.
- The latest public GitHub release remains v0.7.1. This review does not authorize a v0.9.0 release,
  Marketplace submission, outreach, paid action, signing, notarization, or credential action.

## Next week's single priority bottleneck

Capture one naturally occurring task with an exact task-to-Capsule binding and task-specific
context-use disposition, retain the required per-task quality observations, and obtain a separate
reviewer decision. Until that complete bundle exists, keep Issue #24 at 0/15. Continue observing
latency from natural work and fix it only if a current reproducible defect is attributable; do not
generate queries to move the rolling p95.

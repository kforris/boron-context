# Validation status

Last updated: 2026-10-18. This page tracks evidence for the product goal: a new task accurately
continues a real project using source-backed context. It is a progress record, not a release
announcement.

## Current boundary

- The repository contains the v0.9.0 trusted-continuity implementation. The latest public GitHub
  release checked on 2026-10-15 is [v0.7.1](https://github.com/kforris/boron-context/releases/tag/v0.7.1).
- [Issue #24](https://github.com/kforris/boron-context/issues/24) requires 15 naturally occurring
  task resumptions across software contribution, content production, and product/inventory work.
  Each qualifying case needs a private source-linked receipt and a separate reviewer decision. The
  last full review on 2026-10-03 found **0/15**; the 2026-10-12 pass established no new qualifying
  case. We do not infer case success from retrieval or client-reported context use.
- The technical release-candidate checks and public release decision are separate. See the
  [release checklist](release-checklist.md) for the current gates. No public v0.9.0 release has
  been authorized by this progress update.

## 2026-10-12 progress

- Captured a dated, private GitHub Traffic baseline for views, clones, referrers, and popular paths.
  Traffic is a rolling 14-day measurement; clones and unique clones are not verified people,
  installations, or active users. No retained same-method historical peak is available yet.
- Added a repeatable [traffic capture helper](../scripts/capture_github_traffic.py) for maintainers.
  It saves raw API responses outside the repository and refuses to overwrite an existing daily
  snapshot. Example:

  ```sh
  python3 scripts/capture_github_traffic.py --output-root /private/path/to/receipts
  ```

- Opened a private case register against Issue #24. Missing observations remain unknown and an
  independent reviewer must decide whether a case qualifies.

A targeted scan of retained 2026-10-03 through 2026-10-11 Markdown and JSON receipts found no
artifact that combined selected Capsule evidence with a separate reviewer decision, so the case
count remains 0/15 rather than treating missing evidence as failure or success. A reusable
[first-use validation protocol](first-use-validation.md) now defines the isolated clean-install,
first-Capsule, second-task, recovery, uninstall, and independent-review receipts.

Next: execute that protocol in an isolated environment or add a naturally occurring task only when
its complete private evidence bundle exists. Public summaries will omit private task material and
credentials.

## 2026-10-13 progress

- A fresh isolated lifecycle rehearsal reproduced a clean-install blocker on Apple Silicon macOS
  with the Swift 6.4 Command Line Tools: the menu build could not load
  `SwiftUIMacros.StateMacro` for one view-local `@State` property. The failure receipt confirmed
  `productionDatabaseTouched=false`.
- The panel height was moved into the existing observable store without changing the sizing or zoom
  policy. On the same host, the current v0.9.0 release build then succeeded, and the isolated clean
  daemon, menu, Codex plugin, uninstall, and database-retention stages all passed.
- The full historical upgrade/rollback rehearsal remains incomplete on this host because the
  extracted v0.7.8 menu source contains the same incompatible `@State` form. This is retained as a
  failed/partial result rather than counted as lifecycle success. The current-source fix still
  requires exact-head macOS/Xcode CI before merge.

This engineering result does not count as an Issue #24 task resumption or an independent first-use
review. The next product evidence remains a dedicated-account first Capsule plus separate new-task
continuation and reviewer decision.

## 2026-10-14 progress

- The lifecycle controller now applies an exact-match build compatibility shim only to its
  disposable extracted v0.7.8 menu source. The shim mirrors the current panel-height repair and
  fails closed if the historical source no longer matches the reviewed form.
- On the same Apple Silicon host, the isolated v0.7.8-to-v0.9.0 rehearsal passed current clean
  install/uninstall, previous daemon/menu/plugin install, pre-upgrade backup, upgrade continuity,
  restore into an empty database, daemon/menu/plugin rollback, rollback continuity, and final
  uninstall with durable data retained. The receipt records `productionDatabaseTouched=false`.
- Rehearsal receipts are now written with mode `0600`, matching the private-evidence contract.

This closes the 2026-10-13 historical upgrade/rollback engineering gap. It does not replace the
operator-visible [first-use validation](first-use-validation.md), provide an independent review, or
advance Issue #24 beyond 0/15.

## 2026-10-15 progress

- Prepared a bounded [volunteer trial kit](volunteer-trial-kit.md) for 3–5 opt-in participants. It
  keeps installation, first Capsule, and second-task reuse as separate conversion checkpoints and
  preserves `unknown` rather than treating missing evidence as zero.
- Added a disposable public fixture, a redaction-first support diagnostic checklist, and an
  [anonymous feedback template](trial-feedback-template.md). The form requests no identity,
  repository, prompt, or source content.
- The material is preparation only. No participant was contacted, invited, counted, or inferred
  from GitHub traffic, and no public release or Marketplace action was authorized.

Issue #24 therefore remains 0/15 with 0 independent reviews. The next evidence-bearing step is an
opt-in operator-visible first-use run with a separate reviewer, not another synthetic task.

## 2026-10-16 progress

- Audited the retrieval-latency samples behind the current release-candidate gate instead of
  generating repeated queries to improve the window. The 7-day window contains 10 natural samples
  with average / linear p95 / maximum latency of `145.50 / 409.85 / 566 ms`. The `566 ms` sample
  occurred on 2026-10-11 and comprised `200 ms` in Ontology plus `351 ms` in the live Markdown
  stage. The following nine samples are `33–219 ms`; the newest sample is `95 ms`.
- The 30-day window contains 43 samples at `178.02 / 251.40 / 2,843 ms`. Its three observations
  above `250 ms` are `2,843`, `566`, and `255 ms`; the oldest and largest occurred on 2026-09-24,
  including `2,202 ms` in the live Codebase Memory stage.
- These retained observations keep both rolling p95 gates above the `<=250 ms` threshold. Current
  behavior did not reproduce a material defect, so no code change, sample deletion, synthetic
  query, or historical rewrite was made. The release candidate remains `NO-GO` while the windows
  mature or a reproducible defect is found.

Issue #24 remains 0/15 with 0 independent reviews. The dedicated-account first-use run still needs
an opt-in operator and a separate reviewer; local engineering rehearsal cannot substitute for that
evidence.

## 2026-10-17 progress

- Intake found one naturally occurring content-production task with a concrete verified output and
  private source-linked receipts. It is retained as a candidate, not a qualifying case.
- The retained task receipt does not independently bind the task thread to the nearby project
  Capsule, no task-specific context-use disposition was recorded, and per-task omission, stale-fact,
  repeated-retrieval, correction, and signed source-window observations remain unknown.
- No separate reviewer decision exists. Issue #24 therefore remains **0/15** with **0 independent
  reviews**; missing evidence was not converted into a pass or failure.
- The 2026-10-17 rolling readback is still `NO-GO`: 7-day eligible adoption is `126/147 = 85.71%`
  and eligible selected-source coverage is `22/22 = 100%`, while retrieval p95 remains
  `399 ms` over 11 samples. The 30-day values are `576/663 = 86.88%`, `68/68 = 100%`, and
  `255 ms` over 41 samples. Boron-owned LLM calls remain zero.

The next evidence-bearing step is to retain an exact task-to-Capsule binding and task-specific
context disposition as part of the task receipt, then obtain a separate reviewer decision. The
private task evidence and GitHub Traffic snapshot remain outside the repository.

## 2026-10-18 weekly review

The [2026-10-18 weekly review](weekly-review-2026-10-18.md) records one pending natural-task
candidate, 0/15 qualifying Issue #24 cases, 0 independent reviews, the completed isolated lifecycle
rehearsal, trial-material readiness, current release gates, and the GitHub Traffic interpretation
boundary. It keeps automated engineering rehearsal separate from operator-visible first-use and
second-task evidence.

Current eligible adoption and source-coverage gates pass, while retrieval p95 remains above 250 ms
over both the 7-day and 30-day windows. The release candidate therefore remains `NO-GO`. Next week's
single priority is one complete natural-task evidence bundle with exact task-to-Capsule binding,
task-specific context disposition, required quality observations, and a separate reviewer decision.

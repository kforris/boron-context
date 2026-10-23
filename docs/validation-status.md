# Validation status

Last updated: 2026-10-23. This page tracks evidence for the product goal: a new task accurately
continues a real project using source-backed context. It is a progress record, not a release
announcement.

## Current boundary

- The repository contains the v0.9.0 trusted-continuity implementation. The latest public GitHub
  release checked on 2026-10-21 is [v0.7.1](https://github.com/kforris/boron-context/releases/tag/v0.7.1).
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

## 2026-10-19 progress

- Retained a second natural-task candidate from a software-contribution audit. Its exact Codex task,
  Boron session, and Capsule are now bound in the private evidence register, and its material
  `RISK_STOP` output is independently reproducible from retained receipts.
- The task did not record a task-specific context-use disposition, its selected eligible file
  sources lacked measured source-window size, and no separate reviewer decision exists. Critical
  omissions and stale-fact use therefore remain unknown; the candidate is `pending` and does not
  advance Issue #24 beyond **0/15** or **0 independent reviews**.
- The 7-day retrieval window now passes at `201.55 ms` linear p95 over 8 natural samples. The
  30-day window remains above the gate at `317.20 ms` over 37 samples, including retained historical
  tails; no sample was deleted or manufactured.

The next qualifying step remains a natural task that records exact Capsule selection and a
task-specific applied/rejected/stale disposition, followed by a separate reviewer decision. Public
release, Marketplace submission, outreach, and marketing remain unauthorized.

## 2026-10-20 progress

- Retained a third naturally occurring candidate from a product/inventory operation. Its exact task
  thread, Boron session, Capsule, five selected historical receipts, terminal output, and safety
  result are bound in the private case register.
- A separate controller review compared the task output with the complete terminal history and exit
  receipt. The task-output review passed: the controller ran once, preserved five blocked sources,
  completed independently safe synchronization, deleted no local files, and kept logical transfer
  separate from the observed filesystem free-space delta. No critical omission, stale-fact use,
  repeated Capsule retrieval, or human correction was observed.
- The originating task still has no task-specific applied/rejected/stale context-use disposition.
  Its five eligible selected sources also lack measured source-window size, so signed source-window
  tokens remain unknown.

The private register now contains three natural candidates and one independently reviewed
candidate. None qualifies, so Issue #24 remains **0/15**. The next evidence-bearing task must record
an exact task-to-Capsule binding and context-use disposition during the task, preserve measured
source-window coverage, and then receive a separate review. Public release, Marketplace submission,
outreach, and marketing remain unauthorized.

## 2026-10-21 progress

- Retained a fourth naturally occurring candidate from a content-production task. Its exact task
  thread, Boron session, Capsule, five selected historical/ontology facts, three draft receipts,
  validator result, and writer-lease release are bound in the private case register.
- A separate controller review passed the task output: three distinct videos passed local QA and
  platform readback; the exact account's live draft count moved from 76 to 79; every item remained
  unpublished and unscheduled; and the exact writer lease was released. The task treated the
  selected 2026-10-18 upload blocker as historical and rechecked live state instead of reusing it as
  current.
- The originating task still has no task-specific applied/rejected/stale context-use disposition.
  Four eligible selected file sources also lack measured source-window size; one selected ontology
  relation is excluded by the source-window contract. Signed source-window tokens therefore remain
  unknown for this task.

The private register now contains four natural candidates and two independently reviewed
candidates. None qualifies, so Issue #24 remains **0/15**. The next evidence-bearing task must record
the task-specific context-use disposition and measured source-window coverage at task time, then
receive a separate review. Public release, Marketplace submission, outreach, and marketing remain
unauthorized.

## 2026-10-22 progress

- Retained a fifth naturally occurring candidate from a software-contribution audit. Its exact task
  thread, Boron session, Capsule, selected facts, material `RISK_STOP` receipt, and lease release are
  bound in the private case register.
- The originating task reported a validated `applied` disposition for two prior observations, used
  them only as historical baselines, and refreshed mutable GitHub and coordinator state before
  deciding. A separate controller review passed the task output: six bounded candidate audits found
  no item clearing ownership, contract, provenance, overlap, and risk gates; no candidate,
  reservation, implementation, or public write was created.
- The context-use receipt remains client-reported evidence, not independent proof of benefit. The
  selected Capsule has `0/2` measured eligible source-window coverage; six ontology-derived
  selections are excluded and two legacy activity selections are unobservable. Signed task-level
  source-window tokens therefore remain unknown.

The private register now contains five natural candidates and three independently reviewed
candidates. None qualifies, so Issue #24 remains **0/15**. The next qualifying task still needs
exact task-to-Capsule binding, a task-specific context disposition, measured eligible source-window
coverage, and a separate review. Public release, Marketplace submission, outreach, and marketing
remain unauthorized.

## 2026-10-23 progress

- Retained a sixth naturally occurring candidate from a content-production task. Its exact task,
  Boron session, four same-trace Capsule samples, batch receipts, three per-item platform receipts,
  validator result, and writer-lease release are bound in the private case register.
- A separate controller review passed the task output: three distinct first-attempt items passed
  local QA and exact-account platform readback; the draft count moved from 81 to 84; every item
  remained unpublished and unscheduled; the task stopped at three within the five-attempt ceiling;
  a read-only validator rerun exited 0; and the exact writer lease read back `locked=false`.
- The selected historical receipts were not treated as current account state. The task required a
  current-date decision and refreshed the live draft baseline before acting. No critical omission,
  stale-fact use, human correction, publication, scheduling, extra attempt, or lease discrepancy
  was observed.
- The originating task still has no task-specific applied/rejected/stale context-use disposition.
  Four eligible selected file sources also lack measured source-window size, while one ontology
  relation is excluded. Conversation compaction emitted four equivalent Capsule samples under one
  trace; this repeated retrieval is retained as an observation rather than silently collapsed.

The private register now contains six natural candidates and four independently reviewed
candidates. None qualifies, so Issue #24 remains **0/15**. The next qualifying task still needs a
single auditable task-to-Capsule path, a task-specific context disposition, measured eligible
source-window coverage, and a separate review. Public release, Marketplace submission, outreach,
and marketing remain unauthorized.

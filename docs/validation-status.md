# Validation status

Last updated: 2026-10-14. This page tracks evidence for the product goal: a new task accurately
continues a real project using source-backed context. It is a progress record, not a release
announcement.

## Current boundary

- The repository contains the v0.9.0 trusted-continuity implementation. The latest public GitHub
  release checked on 2026-10-14 is [v0.7.1](https://github.com/kforris/boron-context/releases/tag/v0.7.1).
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

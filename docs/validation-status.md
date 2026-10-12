# Validation status

Last updated: 2026-10-12. This page tracks evidence for the product goal: a new task accurately
continues a real project using source-backed context. It is a progress record, not a release
announcement.

## Current boundary

- The repository contains the v0.9.0 trusted-continuity implementation. The latest public GitHub
  release checked on 2026-10-12 is [v0.7.1](https://github.com/kforris/boron-context/releases/tag/v0.7.1).
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

Next: inspect naturally occurring resumptions for complete evidence bundles, then test the first
install and second-task path in an isolated environment. Public summaries will omit private task
material and credentials.

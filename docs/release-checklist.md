# Boron Context release-candidate checklist

This checklist controls the macOS + Codex release-candidate boundary. Passing it does not authorize
a public GitHub release, Marketplace submission, paid distribution, or marketing action.

## Supported scope

- [ ] Apple Silicon macOS 14 or newer
- [ ] Node.js 20.19 or newer
- [ ] PostgreSQL 15 or newer
- [ ] current Codex plugin CLI with local marketplace support
- [ ] source installation; no signed binary installer is claimed
- [ ] loopback daemon is the only privileged write surface; LAN MR remains optional and read-only

Linux service packaging, Intel macOS, a signed binary installer, and hosted/multi-user deployment
are outside this release-candidate scope.

## Version and artifacts

- [ ] `package.json`, lockfile, menu `CFBundleShortVersionString`, MCP server version, plugin semantic
      core, release notes, and changelog agree
- [ ] menu `CFBundleVersion` advances monotonically
- [ ] `npm run plugin:check` proves the 12-hex cache key covers the complete plugin payload
- [ ] `npm pack --dry-run` contains only intended distributable files
- [ ] source, `origin/main`, installed plugin cache, daemon runtime, menu app, and Codebase Memory
      index are checked separately after deployment

## Build and test gates

- [ ] `npm run check`
- [ ] `npm run format:check`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] isolated PostgreSQL migrations and integration fixtures pass; migration rerun is idempotent
- [ ] `swift test --package-path apps/BoronMenuBar`
- [ ] `swift build -c release --package-path apps/BoronMenuBar`
- [ ] all required GitHub checks pass on the exact merge candidate and final main

## Isolated lifecycle rehearsal

Run on a dedicated macOS operator account or with the repository rehearsal:

```bash
npm run lifecycle:rehearse -- \
  --previous-ref 23fbd277c1575d0aa48b89744ed2974bc4350693 \
  --receipt /path/outside/the/repository/boron-lifecycle-receipt.json
```

- [ ] temporary HOME and CODEX_HOME are used
- [ ] PostgreSQL cluster, databases, daemon port, and launchd labels are unique
- [ ] current daemon, menu, and Codex plugin install cleanly and uninstall without deleting the
      migrated database
- [ ] previous daemon, menu, and Codex plugin install successfully
- [ ] pre-upgrade data sentinel is backed up with SHA-256 receipt
- [ ] current daemon, menu, and plugin upgrade successfully without losing the sentinel
- [ ] backup restores into a confirmed-empty database and the sentinel is readable
- [ ] database plus daemon/menu/plugin roll back to the prior version
- [ ] uninstall removes launch agents, menu app, plugin, and marketplace registration
- [ ] uninstall leaves the database, token/state directory, logs, and backup untouched
- [ ] final receipt says `status=passed` and `productionDatabaseTouched=false`
- [ ] no rehearsal launchd labels, processes, or PostgreSQL instance remain

The script never uses the default Boron labels or production database. It applies a disposable label
shim only to the extracted previous release because versions before 0.8 used fixed labels.

## Privacy, security, retention, and recovery

- [ ] no prompt, transcript, title, preview, credential, or raw private source is copied into task
      ownership synchronization
- [ ] token file and lifecycle receipts use mode `0600`; database passwords are passed to PostgreSQL
      tools through `PGPASSWORD`, not command arguments or receipts
- [ ] gateway remains loopback-only; Inspector and optional LAN MR boundaries match
      [`SECURITY.md`](../SECURITY.md)
- [ ] unknown ontology vocabulary, project mismatch, non-empty restore targets, checksum mismatch,
      and ambiguous/high-risk action authorization fail closed
- [ ] PostgreSQL is the durable semantic store; logs and local state stay under the documented macOS
      paths until the operator explicitly removes them
- [ ] backup does not overwrite an existing artifact; restore requires `--confirm-empty-target`
- [ ] rollback restores the pre-upgrade database before reinstalling the prior runtime artifacts
- [ ] support requests contain versions, receipts, and redacted error summaries, never credentials or
      private context

## Product-health evidence

- [ ] known P0/P1 count is zero
- [ ] wrong-project retrieval and writeback are zero
- [ ] 7-day eligible observable adoption is at least 80%, with numerator and eligible denominator
- [ ] documented held-out recall@5 is at least 0.80 without regression from the frozen baseline
- [ ] retrieval p95 is at most 250 ms
- [ ] selected-source eligible coverage is at least 80%, with exclusions and unobservable reasons
- [ ] stale/failed/future-skew sessions and pending corrections are reviewed separately
- [ ] Boron-owned online LLM calls are zero

Do not average these into one health score. An unmet row is a release-candidate `NO-GO`, even when
code, CI, or lifecycle rehearsal passes.

## Human go/no-go

- [ ] scope and known limitations are accepted
- [ ] exact commit and release notes are selected
- [ ] public release and Marketplace actions receive separate explicit approval
- [ ] paid distribution, credentials, signing/notarization, and marketing receive their own approval

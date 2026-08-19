# Security policy

Boron Context is release-candidate software that reads local work context. Do not deploy it with
sensitive production data until a stable release is available.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or leaked secret. Use the repository's
**Security** tab to submit a private vulnerability report.

Include the affected version or commit, reproduction steps, expected impact, and suggested
mitigation. Never include real credentials or private user data.

## Current boundaries

- The gateway binds to loopback by default.
- Context resolution requires a bearer token stored with mode `0600`.
- Request bodies are capped at 256 KiB.
- Token comparison is constant-time after hashing.
- PostgreSQL and adapter credentials come from environment or OS-protected configuration.
- The read-only Meter Inspector requires the same bearer token, omits excerpts, and strips URL
  user-info/query values before returning source URIs. It never returns the daemon token.
- Inferred semantic relationships must not become confirmed facts without an explicit decision.
- The privileged daemon's remote access remains outside the supported threat model. The optional
  Quest LAN MR process is a separate, explicitly private-IPv4, read-only boundary: HTTPS data access
  requires single-use pairing, sessions are client-bound, and only three Inspector read routes are
  forwarded to loopback.
- The Quest CA is downloaded from a certificate-only HTTP bootstrap. Before installation, users must
  compare its SHA-256 fingerprint with the value printed on the trusted Mac by
  `boron-context lan-inspector pair`; a mismatch means the bootstrap may have been substituted.
- The LAN MR process caps bodies at 64 KiB, rate-limits failed codes, rotates the pairing secret on
  success, and has no route for lifecycle, activity, correction, or other semantic writes.
- Lifecycle backups and receipts use mode `0600`. Backup never overwrites an artifact, restore
  accepts only a confirmed empty database, and PostgreSQL passwords are excluded from arguments and
  receipts.
- Uninstall preserves PostgreSQL, the token/state directory, logs, and backups. Their later deletion
  is a separate operator-owned retention decision rather than an implicit uninstall side effect.

Run before contributing:

```bash
npm audit --omit=dev --audit-level=high
npm run check
```

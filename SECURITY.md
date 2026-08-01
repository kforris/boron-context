# Security policy

Boron Context is pre-alpha software that reads local work context. Do not deploy it with sensitive
production data until a stable release is available.

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
- Remote access is not part of the current supported threat model.

Run before contributing:

```bash
npm audit --omit=dev --audit-level=high
npm run check
```

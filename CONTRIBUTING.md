# Contributing

Thank you for helping build Boron Context.

## Before opening a pull request

1. Keep the headless daemon independently usable.
2. Preserve provenance and confirmation state.
3. Do not merge source systems into one untyped knowledge store.
4. Avoid platform-specific behavior in core contracts.
5. Add tests for behavior and migration changes.

Run:

```bash
npm install
npm run check
npm audit --omit=dev --audit-level=high
```

## Pull requests

Describe:

- the problem and intended behavior;
- the source-of-truth boundary affected;
- backward compatibility or migration impact;
- security and privacy considerations;
- verification evidence.

Do not include secrets, personal project paths, private customer data, generated build output, or
unrelated formatting changes.

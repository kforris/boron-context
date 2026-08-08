# Project identity discovery and repair

Boron resolves project hints through exact, confirmed identities. A canonical identity alias is
globally unique; historical aliases may remain in the database for audit, but ambiguous aliases do
not resolve. Name-only matches discovered during reconciliation create `candidate`
`MAY_INCLUDE_WORKSPACE` relations and require later human review.

## Authoritative sources

- The Codex desktop `local-projects` registry establishes registered project IDs and names.
- Exact non-home paths in that registry may establish confirmed `HAS_REGISTERED_ROOT` relations.
- An existing Boron project whose source exactly equals such a root may establish a confirmed
  `HAS_REGISTERED_WORKSPACE` relation.
- A user-approved manifest may rename a canonical group, adopt an existing Boron project, add an
  exact root, supersede a wrong historical alias, or retire a misleading historical object.
- The same manifest may declare `independentProjects` that are not present in Codex local-project
  metadata. They become confirmed only because the operator supplied a stable source URI and
  approved the manifest; they are never inferred from directory names.
- A broad home path is recorded as ignored and is never treated as a project root.

The manifest is operator-owned local configuration. Do not commit a personal manifest, project
IDs, private names, or local paths to this repository.

An independent project entry has this shape:

```json
{
  "version": 1,
  "authority": "user_approved",
  "provenance": "Reviewed by the local operator on 2026-08-07",
  "projects": {},
  "independentProjects": [
    {
      "canonicalName": "Example Product",
      "sourceUri": "project://example-product",
      "aliases": ["ExampleProduct"],
      "authoritativeRoots": ["/Users/operator/Projects/example-product"]
    }
  ]
}
```

The source URI must be stable and unique. Exact roots may be omitted; the home directory and
missing directories are reported as ignored. Identity collisions fail the preview.

## Operator procedure

1. Back up the target PostgreSQL database.
2. Apply schema migrations:

   ```bash
   npm run db:migrate
   ```

3. Preview the deterministic plan. This performs no ontology mutation:

   ```bash
   node dist/cli.js reconcile-projects \
     --state "$HOME/.codex/.codex-global-state.json" \
     --manifest "/path/to/user-approved-project-manifest.json"
   ```

4. Review every adoption, ignored root, alias supersession, and candidate project ID. Apply only
   after the preview matches the approved registry:

   ```bash
   node dist/cli.js reconcile-projects \
     --state "$HOME/.codex/.codex-global-state.json" \
     --manifest "/path/to/user-approved-project-manifest.json" \
     --apply
   ```

5. Restart the local daemon so the exact identity resolver is active, then verify:

   - canonical aliases resolve to exactly one project;
   - an unregistered project hint returns no project;
   - `HAS_REGISTERED_ROOT` relations are confirmed and use exact non-home roots;
   - `MAY_INCLUDE_WORKSPACE` relations remain candidate;
   - a scoped Inspector graph includes both endpoints of cross-project candidate relations;
   - Codebase Memory and Wiki remain labeled `snapshot` unless a live adapter was actually queried.

Re-running the same manifest is idempotent. Superseded aliases are marked `rejected` with reason and
provenance metadata; their rows are not deleted. Object supersession is also non-destructive: the old
object becomes `rejected`, its current relations receive `valid_to`, and the object metadata and
relation provenance record the canonical replacement and reason.

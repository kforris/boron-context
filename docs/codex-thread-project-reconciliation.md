# Codex thread project context

Boron maintains historical thread-to-project ownership in its own retrieval index. It never rewrites
Codex private global state, and the Codex sidebar remains a presentation surface rather than the
canonical project database.

## Automatic startup path

On each trusted `SessionStart`, the Boron hook:

1. reads the current Codex thread-to-saved-project assignment map and an optional approved review
   plan;
2. verifies the review plan's policy hash and `user_approved` authority;
3. sends only thread IDs, Codex project IDs, classification state, authority, confidence, and
   evidence digests to Boron;
4. imports those observations idempotently into the dedicated thread context index; and
5. bootstraps the current session from a confirmed ownership mapping or exact registered root.

The sync payload never includes task titles, prompts, previews, transcript text, or working
directories. A failed import does not block Codex startup. An unresolved or conflicting identity
fails closed instead of creating a confirmed project from an arbitrary directory.

## Optional historical review

The local reviewer can classify older tasks from local metadata without modifying Codex:

```bash
python3 scripts/reconcile_codex_thread_projects.py \
  --policy "$HOME/.codex/boron-context/thread-project-policy.json" \
  --output "$HOME/.codex/boron-context/thread-project-plan.json"
```

The policy must explicitly declare `"authority": "user_approved"`. Review `summary`, `moves`,
`candidate`, and `projectless` before keeping the plan at that path. The SessionStart hook accepts
the plan only while its recorded policy SHA-256 still matches the policy file.

The reviewer may inspect titles and first-message metadata locally to apply the approved rules. It
replaces those text fields with a digest in the local plan; working paths, project labels, and rule
reasons remain there so the operator can audit the classification. The hook discards those review
fields and sends only IDs, classifications, authority, confidence, and evidence digests to Boron.
Re-running the reviewer is read-only, and the machine-specific plan must not be committed.

## Evidence model

- An explicit user-approved plan has the highest authority.
- Current Codex saved-project assignments, exact registered roots, and confirmed parent inheritance
  may establish confirmed ownership.
- Weak semantic matches stay `candidate` and cannot bootstrap a project context.
- Records with no project meaning may be auditable `projectless`; they are not forced into a
  catch-all project.
- Equal-authority disagreement becomes `conflicted` and fails closed.
- Repeating the same snapshot is a no-op, while changed evidence remains append-only and auditable.

Thread ownership is operational retrieval state, not a set of Ontology nodes. This keeps hundreds
of historical task records from making the relationship graph unreadable.

## Verify

Use the plugin's `get_codex_sync_health` tool, or call the authenticated endpoint directly:

```bash
curl -sS http://127.0.0.1:41635/v1/metrics/codex-sync \
  -H "Authorization: Bearer $BORON_CONTEXT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Healthy history has no `conflicted` records and no unexpected `candidate` growth. `projectless`
records are expected when the approved policy explicitly excludes greetings, probes, and other
non-project tasks. No Codex restart, quit delay, or private-state patch is part of this workflow.

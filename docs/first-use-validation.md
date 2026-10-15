# First-use validation protocol

This protocol tests the product claim that a clean Boron Context installation can give a new Codex
task accurate, source-backed project continuity. It is intended for an isolated Apple Silicon macOS
environment and produces a private, reviewable receipt. A passed lifecycle rehearsal is useful
supporting evidence, but it is not a substitute for this operator-visible first-use path.

For a bounded 3–5-person trial, use the [volunteer trial kit](volunteer-trial-kit.md) and its
repository-provided disposable fixture. This protocol remains the acceptance contract.

## Scope and cost boundary

- Supported host: Apple Silicon macOS 14+, Node.js 20.19+, PostgreSQL 15+, and a current Codex CLI
  or desktop build with local plugin support.
- Expected operator time: 30–45 minutes for install, two tasks, backup/restore, and uninstall.
- Boron-owned model calls: 0. Codex usage is whatever the two bounded test tasks consume.
- Use a dedicated macOS test account with no production Boron installation. The repository's
  temporary `HOME`/`CODEX_HOME`, database, port, and launchd-label rehearsal remains a separate
  engineering check; it does not count as an independent first-use result. Never point this
  protocol at a production Boron database.
- Keep the receipt outside the repository. Do not include tokens, credentials, prompts, transcripts,
  private source text, or absolute home-directory paths in a public report.

## Private receipt

Create one JSON receipt before starting. Update it without deleting earlier observations. Every
field may be `unknown`; absence is not a pass or a zero.

```json
{
  "schemaVersion": 1,
  "startedAt": "<UTC timestamp>",
  "completedAt": null,
  "environment": {
    "machine": "Apple Silicon macOS test host",
    "macOS": "<sw_vers -productVersion>",
    "architecture": "<uname -m>",
    "node": "<node --version>",
    "postgresql": "<psql --version>",
    "codex": "<codex --version>",
    "boronCommit": "<git rev-parse HEAD>",
    "isolatedFromProduction": false
  },
  "install": { "result": "pending", "health": "unknown", "pluginVersion": "unknown" },
  "firstCapsule": { "result": "pending", "project": "unknown", "sourceLinks": [] },
  "secondTask": {
    "result": "pending",
    "criticalFactsExpected": 3,
    "criticalFactsObserved": "unknown",
    "wrongProjectFacts": "unknown",
    "repeatedRetrievals": "unknown",
    "humanCorrections": "unknown"
  },
  "recovery": { "backup": "pending", "restoreReadback": "pending" },
  "uninstall": { "result": "pending", "durableDataPreserved": "unknown" },
  "review": { "reviewer": null, "decision": "pending", "reason": null }
}
```

Store artifact paths and SHA-256 values in the private receipt. Do not copy source content into it.

## 1. Prepare the isolated host

Record these observations before installation:

```bash
sw_vers -productVersion
uname -m
node --version
psql --version
codex --version
git rev-parse HEAD
git status --short --branch
```

The operator must confirm that the test database, state directories, ports, and launchd labels do
not match a production installation. Mark `isolatedFromProduction=true` only after that comparison.
If this cannot be established, stop the run.

## 2. Install from the exact source revision

Follow the [operating manual](operating-manual.md#2-install-on-macos) without shortening the plugin
cache path or hand-editing installed artifacts. Review the `SessionStart` and `SessionEnd` hooks once
in a Codex surface that exposes hook review, then open a fresh task.

Verify all of the following separately:

1. `curl -sS http://127.0.0.1:41635/health` reports the expected version, a healthy database, and
   the expected adapters.
2. `codex plugin list --marketplace boron-context --json` selects the installed plugin version.
3. The new task contains `Boron automatic project context` and an active Boron session ID.
4. No production database, state directory, or launchd label changed.

Any wrong version, unhealthy database, missing hook injection, or production-state change is a
failed install. Do not repair the receipt to make the run pass.

## 3. Create a bounded test project

Use a new disposable Git repository in the test account. You may copy
[`examples/first-use-project`](../examples/first-use-project/) or create an equivalent
`PROJECT-CONTEXT.md` with these three facts, then commit it:

1. Decision: JSON is the first export format.
2. Constraint: generated exports are never committed.
3. Next task: add a CSV comparison note without changing the JSON decision.

The exact wording may differ, but the receipt must retain the file URI and commit SHA. Do not use a
real private project for a public demonstration.

## 4. Observe the first Capsule

Open a new Codex task rooted at the fixture repository. Ask it to inspect the project and create a
small, reviewable implementation note that preserves the decision and constraint. Do not restate the
three facts in the task prompt.

The operator records:

- resolved project identity and confidence;
- Capsule ID and selected evidence IDs;
- whether `PROJECT-CONTEXT.md` was selected with a source URI;
- any unresolved project identity, wrong-project evidence, stale fact, or repeated retrieval;
- the concrete output path and SHA-256; and
- the explicit Boron session outcome.

The first Capsule passes only when the exact fixture project is resolved, at least one authoritative
fixture source is selected, no wrong-project fact appears, and the output is consistent with the
three fixture facts.

## 5. Test a new-task continuation

Close the first task. Start a separate Codex task in the same repository and ask it to continue the
next project step without re-explaining the previous decision or constraint. The expected work is a
CSV comparison note; it must not replace JSON as the chosen first format or commit generated
exports.

Record each critical fact independently:

| Check                       | Pass condition                                                |
| --------------------------- | ------------------------------------------------------------- |
| JSON decision               | Retained as the first export format                           |
| Generated-output constraint | No generated export is committed                              |
| Next-task intent            | CSV comparison note is produced without changing the decision |
| Project isolation           | No fact from another project appears                          |
| Source provenance           | Selected source IDs and URIs are retained                     |
| Retrieval behavior          | Repeated retrieval count is observed, not inferred            |
| Human correction            | Count and corrected fact are recorded, or `unknown`           |

The operator does not review their own result. A separate reviewer compares the prompt, selected
source references, repository diff, and output, then sets `pass`, `fail`, or `pending` with a reason.
A client context-use receipt is supporting evidence only; it is not the reviewer decision.

## 6. Verify recovery and uninstall boundaries

Use the [backup and restore procedure](operating-manual.md#restore-and-rollback) to create a
non-overwriting backup and restore it into a confirmed-empty test database. Read back one fixture
milestone from the restored database and retain both receipt hashes.

Then preview and run the [uninstall procedure](operating-manual.md#uninstall). It must remove the
test runtime surfaces while preserving the test database, token/state directory, logs, and backup.
Do not manually delete residue to turn a failed uninstall into a pass.

## Acceptance and reporting

The run passes only when installation, first Capsule, second-task continuation, restore readback,
uninstall preservation, and separate review all pass. A missing observation makes the overall result
`pending`; a wrong-project fact, production-state mutation, credential exposure, or false source
claim makes it `fail`.

Public reporting is limited to anonymized counts, versions, durations, failure classes, and the
review decision. The private receipt and fixture evidence remain local. Passing this protocol does
not authorize a public release, Marketplace submission, outreach, or marketing claim.

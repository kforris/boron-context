# Volunteer trial kit

This kit prepares a bounded Boron Context trial for 3–5 volunteers. It is an operator aid, not an
open invitation, release announcement, or authorization to contact anyone. Run it only after a
volunteer has opted in and an operator has selected the exact source commit.

## Time, cost, and evidence boundary

- Expected participant time: 30–45 minutes for installation and two small tasks.
- Expected reviewer time: 10–15 minutes per participant.
- Boron-owned model calls: 0. The participant's Codex plan supplies any agent usage.
- Infrastructure cost: $0 when the participant already has a supported Mac, PostgreSQL, and Codex.
- Evidence is private by default. Public reporting is limited to anonymous aggregate counts,
  versions, durations, failure classes, and review outcomes.
- A clone, GitHub unique clone, successful health check, or client context-use receipt is not a
  verified installation, participant, second-task reuse, or independent review.

## Supported trial environment

Use an Apple Silicon Mac running macOS 14 or newer, Node.js 20.19 or newer, PostgreSQL 15 or newer,
and a current Codex build with local plugin support. Use a dedicated test account or otherwise prove
that the trial database, state directories, daemon port, and launchd labels do not overlap a
production Boron installation. Stop if isolation cannot be established.

Before the trial, the operator records the exact approved commit and confirms that it passed the
[release checklist](release-checklist.md). The repository is still pre-1.0 source software; no
signed installer is claimed.

## 1. Install the approved source revision

Clone the repository, check out the operator-provided commit, and follow
[Install on macOS](operating-manual.md#2-install-on-macos). Use `npm ci` for the committed lockfile.
Do not shorten plugin cache paths or hand-edit installed artifacts.

Record the first conversion checkpoint, `install_success`, only when all of these pass:

1. `curl -sS http://127.0.0.1:41635/health` reports the expected Boron version, a healthy database,
   and the expected adapters.
2. `codex plugin list --marketplace boron-context --json` selects the expected plugin version.
3. The participant reviews the two lifecycle hooks in a Codex surface that exposes hook review.
4. A fresh task contains `Boron automatic project context` and an active session ID.
5. No production database, state directory, service, or launchd label changed.

If any check fails, record `install_success=false` and continue only with diagnostics. Do not repair
the evidence or count a partial install as success.

## 2. Create the disposable test project

Copy the repository's [`examples/first-use-project`](../examples/first-use-project/) directory to a
new location in the test account, then initialize it as its own Git repository:

```bash
trial_root="$(mktemp -d /tmp/boron-first-use.XXXXXX)"
cp -R examples/first-use-project/. "$trial_root/"
git -C "$trial_root" init
git -C "$trial_root" add .
git -C "$trial_root" commit -m 'Create Boron first-use fixture'
git -C "$trial_root" rev-parse HEAD
```

Retain the fixture commit SHA in the private receipt. The project has three deliberately small facts
in `PROJECT-CONTEXT.md`; do not restate them in either task prompt.

## 3. Observe the first Capsule

Open a new Codex task rooted at the fixture repository and send:

> Inspect this project and create a short implementation note for its current next step. Preserve
> existing decisions and constraints. Do not implement the export itself.

Record `first_capsule=true` only when the exact fixture project is resolved, the project context is
selected with a source URI, no wrong-project fact appears, and the output respects all three facts.
Retain the Capsule ID, selected evidence IDs, output path, output SHA-256, and explicit session
outcome in the private receipt.

## 4. Test second-task reuse

Close the first task. Open a separate task in the same repository and send:

> Continue the next project step without changing earlier decisions or committing generated
> output. Produce only the requested comparison note.

Record `second_task_reuse=true` only when the new task:

- retains the chosen first export format;
- does not commit generated exports;
- produces the requested comparison note without replacing the earlier decision;
- selects source-linked context from the exact fixture project; and
- uses no fact from another project.

Record repeated retrievals and human corrections as observed counts or `unknown`; never infer zero.
A separate reviewer compares both prompts, selected source references, the repository diff, and the
output. Self-review or a client context-use receipt does not satisfy this review.

## 5. Collect a bounded support bundle

If installation or either task is blocked, collect only:

```bash
sw_vers -productVersion
uname -m
node --version
psql --version
codex --version
git rev-parse HEAD
git status --short --branch
curl -sS http://127.0.0.1:41635/health
codex plugin list --marketplace boron-context --json
rg --files "${CODEX_HOME:-$HOME/.codex}/plugins/cache/boron-context" \
  | rg '/context-continuity/SKILL\.md$'
```

Also include the failed step, UTC timestamp, expected result, redacted error class, and relevant
receipt SHA-256. Before sharing, remove usernames, absolute home paths, database passwords, bearer
tokens, private project names, source excerpts, prompts, transcripts, and task titles. Never attach
the token file, `.env`, database dump, complete log directory, `.codex` directory, or private
receipt. When redaction would make the report ambiguous, keep the bundle local and arrange a
screen-shared review instead.

## 6. Recovery, uninstall, and final classification

For the full evidence path, finish the backup/restore and uninstall-retention stages in the
[first-use validation protocol](first-use-validation.md). Preview uninstall before applying it.
Never delete retained data or residue merely to turn a failed check into a pass.

Record the three conversion checkpoints separately:

| Checkpoint          | Allowed values             | Minimum evidence                                                    |
| ------------------- | -------------------------- | ------------------------------------------------------------------- |
| `install_success`   | `true`, `false`, `unknown` | Health, plugin version, hook injection, isolation readback          |
| `first_capsule`     | `true`, `false`, `unknown` | Project ID, source IDs/URIs, output hash, wrong-project observation |
| `second_task_reuse` | `true`, `false`, `unknown` | Three fact checks, source provenance, separate reviewer decision    |

One failed or unknown checkpoint does not erase the others. It does prevent the run from being
reported as an end-to-end success.

## 7. Anonymous feedback

After the technical receipt is closed, offer the participant the
[anonymous feedback template](trial-feedback-template.md). It does not request a name, email,
company, repository, prompt, or source content. Store feedback separately from the technical
receipt and assign only a random response ID. Participation and any question may be declined.

Preparing or completing this kit does not authorize outreach, a public GitHub release, Marketplace
submission, signing, notarization, payment, or marketing.

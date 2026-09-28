# Trusted continuity

The milestone is that a new task can accurately continue one real project without asking the user
to repeat its important decisions, constraints and current state. Retrieval, adoption and successful
task outcomes require separate evidence. This version supplies guarded state changes and a way to
report which selected context informed a task; it does not certify that every project meets the
milestone.

## Reconcile one GitHub pull request

`scripts/reconcile_github_pr.py` is a Python standard-library CLI. It calls the authenticated local
Boron HTTP API and reads one exact pull request through `gh api --hostname github.com`. It does
not access PostgreSQL directly, change GitHub, create a session, discover repositories, run a model,
or install a polling job.

Prerequisites:

- Python 3.10+, an authenticated `gh` CLI and the local Boron daemon;
- migrations applied, including the registered `GITHUB_PR_OPEN`, `GITHUB_PR_CLOSED` and
  `GITHUB_PR_MERGED` relation types;
- an exact project hint and project UUID, plus an exact GitHub `owner/repository` and PR number;
- existing, confirmed `pull_request` and `repository` ontology entities with matching GitHub URLs,
  both owned by that project;
- for apply, an existing active session scoped to the same project.

The helper reads `BORON_DAEMON_TOKEN`, or the normal token file (`BORON_TOKEN_FILE` may override
it). The token is never placed in a command argument or result. `--boron-url` accepts a loopback
HTTP origin only and disables redirects and proxies. The default is `http://127.0.0.1:41635`.

Create a plan using the exact registered project values:

```sh
python3 scripts/reconcile_github_pr.py plan \
  --project-hint "$PROJECT_HINT" \
  --project-id "$PROJECT_ID" \
  --repository gumyr/build123d \
  --number 1389 > pr-plan.json
```

Inspect the plan's `scope`, `source`, `before`, `relationEffects` and `planDigest`. A plan is a
reviewable artifact, not permission to write to a different project. Apply it with the session
belonging to that project:

```sh
python3 scripts/reconcile_github_pr.py apply \
  --plan pr-plan.json \
  --session-id "$BORON_SESSION_ID" > pr-result.json
```

Apply re-reads GitHub and the ontology, reconstructs the permitted effects and compares them with
the reviewed plan. It checks `/health` for `capabilities.relationPreconditions: 1`, so an older
daemon cannot silently discard the guard. One `record_activity` transaction retracts obsolete
state and asserts the deterministic current state. A final ontology read and GitHub read must agree
before the receipt reports success.

| Receipt status         | Meaning                                                      | Next action                                                                    |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `applied_and_verified` | One activity was submitted; both readbacks matched.          | Preserve the activity receipt and use a fresh context query for the next task. |
| `already_current`      | The current confirmed state already matches; zero writes.    | Continue without adding duplicate history.                                     |
| `applied_unverified`   | The activity returned, but a final read failed or disagreed. | Preserve the activity ID; inspect current sources and create a new plan.       |
| `write_not_verified`   | The write request failed or its result is unknown.           | Preserve the digest and idempotency key; re-read before retrying.              |

The last two statuses exit with code `2` and retain a JSON receipt on stdout. Pre-write source,
identity or plan failures exit with code `1`. A failed request is never reported as a completed
repair. A server rejection may mean zero writes; a transport failure can leave the write outcome
unknown.

### State and time semantics

The helper maps GitHub's exact source state to `GITHUB_PR_OPEN`, `GITHUB_PR_CLOSED` or
`GITHUB_PR_MERGED`, directed from the PR to its repository. A closed or merged PR also retracts a
legacy `AWAITING_UPSTREAM_REVIEW` relation. An open PR's review status cannot be inferred from
`state=open`, so that legacy relation is left unchanged in the open case. Other relation types,
such as issue links, remain outside this state reconciliation.

The source's `updatedAt`, `closedAt` and `mergedAt` stay in the activity evidence. The activity's
`occurredAt` is the time this reconciliation observed and repaired the state. This preserves both
source event time and local observation time, without backdating a new retraction before a
relation's creation. Retraction closes the old relation's validity interval; it does not delete
its history.

Unknown or inconsistent source states, wrong repository/number/URL, unresolved projects,
unconfirmed or cross-project entity identities, unavailable sources and ambiguous state relations
all stop before mutation. The current Inspector response has a limit of 500 nodes and 1,000 edges;
the helper refuses any response reaching either limit instead of treating possible truncation as
an exhaustive state set.

### Concurrency and retry boundary

`relationPreconditions` identifies the exact subject URI, managed relation types and expected
active relation IDs. The daemon acquires subject locks, compares the complete current set inside
the transaction, and returns HTTP `409` with `relation_precondition_failed` when it changed.
Normal API relation writes participate in the same locking scheme. Direct database writes do not.

Activity retries use an idempotency key and request-content digest. An identical retry is checked
before relation governance, so a successful retraction can be retried even though its old relation
is no longer active. Reusing the key with a different session or payload is a conflict. The helper
also re-reads state and returns `already_current` after an already-applied plan.

GitHub and PostgreSQL do not share a transaction. The final source read detects a change during the
apply window, but future upstream changes still require a new invocation. This release adds no
automatic polling or guarantee of continuous external freshness.

## Report the context used by a task

Use `record_context_use` (HTTP `POST /v1/context/use`) after a concrete task decision or outcome.
It requires an active session, explicit project hint, capsule ID, selected evidence IDs,
`disposition` (`applied`, `rejected` or `stale`), a bounded summary, an idempotency key and at least
one URI-backed piece of outcome evidence.

The daemon verifies that the capsule belongs to the same project and that every referenced
source was selected into that capsule. `get_context_use_health` (HTTP
`POST /v1/metrics/context/use`) counts these reports by disposition. Its basis is explicitly
`client_report_with_validated_selection`: the database validates the selection and project link;
the client reports adoption and outcome. Missing reports are unknown. A report is not independent
proof that the task improved, that the source was understood correctly, or that rework decreased.

For milestone evaluation, retain the fresh-task brief, retrieved sources, decision/output artifact,
and a separate reviewer result. Measure stale-fact use, missing critical facts, repeated queries
and human corrections on actual continuations. Keep this evaluation separate from operational
health and report counts. Planned evaluations must not be labelled complete without their receipts.

## Token accounting

The aggregate context meter exposes signed `sourceWindow.netSavingsTokens` alongside the legacy
nonnegative `savingsTokens`. Net savings is measured source tokens minus excerpt tokens. A negative
number means expansion among the measured sources. Unmeasured sources and the downstream agent's
billing are outside this number, so it cannot be presented as total model-cost savings.

## 中文操作边界

目标是让新任务准确接续真实项目。先生成精确项目、仓库和 PR 的计划，核对当前关系与来源，再用该项目
已有的会话执行。执行前后都会重读来源；并发关系变化会使事务拒绝写入，旧关系保留历史。

`applied_and_verified` 才表示本次修复及读回完成；`already_current` 表示无需写入；
`applied_unverified` 或 `write_not_verified` 必须保留回执并重新核对。该工具不创建自动轮询，
不把“取回上下文”或客户端报告“采用了上下文”当作任务质量提升的独立证明。

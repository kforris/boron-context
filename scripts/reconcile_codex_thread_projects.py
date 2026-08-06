#!/usr/bin/env python3
"""Deterministically review Codex thread-to-project ownership for Boron.

The Codex desktop application keeps project assignments in
``.codex-global-state.json`` while thread metadata lives in ``state_5.sqlite``.
This operator tool produces a credential-redacted, user-reviewable plan. It is
read-only and never modifies Codex private state. The trusted SessionStart hook
can import an approved plan into Boron's own thread-to-project index.

Policy files are local, user-approved configuration.  They should not be
committed when they contain private project IDs, paths, or names.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


POLICY_VERSION = 1
STATE_ASSIGNMENTS_KEY = "thread-project-assignments"
PROJECTLESS_IDS_KEY = "projectless-thread-ids"


class ReconcileError(RuntimeError):
    """Raised when reconciliation cannot proceed safely."""


@dataclass(frozen=True)
class ThreadRecord:
    thread_id: str
    cwd: str
    title: str
    first_user_message: str
    preview: str
    source: str
    archived: bool
    created_at: int
    updated_at: int
    git_origin_url: str
    agent_path: str

    @property
    def semantic_text(self) -> str:
        fields = (
            self.title[:12000],
            self.first_user_message[:12000],
            self.preview[:12000],
        )
        return " ".join(fields).casefold()

    @property
    def title_digest(self) -> str:
        return hashlib.sha256(self.title.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Evidence:
    project_name: str
    priority: int
    confirmation_state: str
    rule_id: str
    reason: str


@dataclass(frozen=True)
class Decision:
    thread_id: str
    status: str
    project_name: str | None
    evidence: tuple[Evidence, ...]
    projectless_reason: str | None = None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--state",
        default=str(Path.home() / ".codex" / ".codex-global-state.json"),
        help="Codex desktop global state JSON",
    )
    parser.add_argument(
        "--database",
        default=str(Path.home() / ".codex" / "state_5.sqlite"),
        help="Codex thread metadata SQLite database",
    )
    parser.add_argument("--policy", required=True, help="User-approved reconciliation policy")
    parser.add_argument("--output", help="Write the redacted plan to this JSON file")
    return parser.parse_args(argv)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json_file(path: Path) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ReconcileError(f"Unable to read {path}: {exc}") from exc
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ReconcileError(f"Invalid JSON at {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ReconcileError(f"Expected a JSON object at {path}")
    return value, raw


def load_policy(path: Path, state: dict[str, Any]) -> dict[str, Any]:
    policy, _ = read_json_file(path)
    if policy.get("version") != POLICY_VERSION:
        raise ReconcileError(f"Policy version must be {POLICY_VERSION}")
    if policy.get("authority") != "user_approved":
        raise ReconcileError("Policy authority must be user_approved")
    projects = policy.get("projects")
    if not isinstance(projects, dict) or not projects:
        raise ReconcileError("Policy projects must be a non-empty object")
    state_projects = state.get("local-projects")
    if not isinstance(state_projects, dict):
        raise ReconcileError("Codex state has no local-projects registry")
    seen_project_ids: set[str] = set()
    for name, spec in projects.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(spec, dict):
            raise ReconcileError("Every policy project needs a non-empty name and object value")
        project_id = spec.get("projectId")
        if not isinstance(project_id, str) or project_id not in state_projects:
            raise ReconcileError(f"Unknown Codex project ID for policy project {name}")
        if project_id in seen_project_ids:
            raise ReconcileError(f"Codex project ID is claimed twice: {project_id}")
        seen_project_ids.add(project_id)
    rules = policy.get("rules", [])
    if not isinstance(rules, list):
        raise ReconcileError("Policy rules must be an array")
    seen_rule_ids: set[str] = set()
    for rule in rules:
        validate_rule(rule, projects, seen_rule_ids)
    overrides = policy.get("threadOverrides", {})
    if not isinstance(overrides, dict):
        raise ReconcileError("threadOverrides must be an object")
    for thread_id, override in overrides.items():
        if not isinstance(thread_id, str) or not isinstance(override, dict):
            raise ReconcileError("Invalid thread override")
        if override.get("project") not in projects:
            raise ReconcileError(f"Unknown override project for thread {thread_id}")
        if not isinstance(override.get("reason"), str) or not override["reason"].strip():
            raise ReconcileError(f"Thread override {thread_id} requires a reason")
    projectless_overrides = policy.get("projectlessOverrides", {})
    if not isinstance(projectless_overrides, dict):
        raise ReconcileError("projectlessOverrides must be an object")
    for thread_id, reason in projectless_overrides.items():
        if not isinstance(thread_id, str) or not isinstance(reason, str) or not reason.strip():
            raise ReconcileError("Every projectless override needs a thread ID and reason")
        if thread_id in overrides:
            raise ReconcileError(
                f"Thread {thread_id} cannot have project and projectless overrides"
            )
    return policy


def validate_rule(
    rule: Any, projects: dict[str, Any], seen_rule_ids: set[str]
) -> None:
    if not isinstance(rule, dict):
        raise ReconcileError("Every rule must be an object")
    rule_id = rule.get("id")
    if not isinstance(rule_id, str) or not rule_id.strip() or rule_id in seen_rule_ids:
        raise ReconcileError(f"Invalid or duplicate rule id: {rule_id}")
    seen_rule_ids.add(rule_id)
    if rule.get("project") not in projects:
        raise ReconcileError(f"Rule {rule_id} references an unknown project")
    if rule.get("kind") not in {
        "automation_id",
        "cwd_prefix",
        "cwd_contains",
        "text_contains",
        "text_regex",
        "git_origin_regex",
    }:
        raise ReconcileError(f"Rule {rule_id} has an unsupported kind")
    values = rule.get("values")
    if not isinstance(values, list) or not values or not all(
        isinstance(value, str) and value for value in values
    ):
        raise ReconcileError(f"Rule {rule_id} requires non-empty string values")
    priority = rule.get("priority")
    if not isinstance(priority, int) or not 0 <= priority <= 100:
        raise ReconcileError(f"Rule {rule_id} priority must be an integer from 0 to 100")
    if rule.get("confirmationState") not in {"confirmed", "candidate"}:
        raise ReconcileError(f"Rule {rule_id} needs a valid confirmationState")
    if rule.get("kind") in {"text_regex", "git_origin_regex"}:
        for pattern in values:
            try:
                re.compile(pattern, re.IGNORECASE)
            except re.error as exc:
                raise ReconcileError(f"Rule {rule_id} has invalid regex: {exc}") from exc


def load_threads(database_path: Path) -> list[ThreadRecord]:
    uri = f"file:{database_path}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT id, cwd, title, first_user_message, preview, source, archived,
                   created_at, updated_at, COALESCE(git_origin_url, '') AS git_origin_url,
                   COALESCE(agent_path, '') AS agent_path
              FROM threads
            """
        ).fetchall()
    except sqlite3.Error as exc:
        raise ReconcileError(f"Unable to read thread database {database_path}: {exc}") from exc
    finally:
        if "connection" in locals():
            connection.close()
    return [
        ThreadRecord(
            thread_id=row["id"],
            cwd=row["cwd"],
            title=row["title"],
            first_user_message=row["first_user_message"],
            preview=row["preview"],
            source=row["source"],
            archived=bool(row["archived"]),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
            git_origin_url=row["git_origin_url"],
            agent_path=row["agent_path"],
        )
        for row in rows
    ]


def automation_id(record: ThreadRecord) -> str | None:
    match = re.search(r"Automation ID:\s*([^\s<]+)", record.title[:12000], re.IGNORECASE)
    return match.group(1).casefold() if match else None


def parent_thread_id(record: ThreadRecord) -> str | None:
    if not record.source.startswith("{"):
        return None
    try:
        source = json.loads(record.source)
    except json.JSONDecodeError:
        return None
    if not isinstance(source, dict):
        return None
    value = (
        source.get("subagent", {})
        .get("thread_spawn", {})
        .get("parent_thread_id")
    )
    return value if isinstance(value, str) and value else None


def normalized_path(value: str) -> str:
    return os.path.normpath(os.path.expanduser(value))


def is_path_prefix(candidate: str, prefix: str) -> bool:
    candidate_path = normalized_path(candidate)
    prefix_path = normalized_path(prefix)
    return candidate_path == prefix_path or candidate_path.startswith(prefix_path + os.sep)


def wildcard_matches(value: str, patterns: Iterable[str]) -> bool:
    folded = value.casefold()
    for pattern in patterns:
        pattern_folded = pattern.casefold()
        if pattern_folded.endswith("*"):
            if folded.startswith(pattern_folded[:-1]):
                return True
        elif folded == pattern_folded:
            return True
    return False


def rule_matches(rule: dict[str, Any], record: ThreadRecord) -> bool:
    kind = rule["kind"]
    values = rule["values"]
    if kind == "automation_id":
        value = automation_id(record)
        return value is not None and wildcard_matches(value, values)
    if kind == "cwd_prefix":
        return any(is_path_prefix(record.cwd, value) for value in values)
    if kind == "cwd_contains":
        cwd = record.cwd.casefold()
        return any(value.casefold() in cwd for value in values)
    if kind == "text_contains":
        text = record.semantic_text
        return any(value.casefold() in text for value in values)
    if kind == "text_regex":
        return any(re.search(value, record.semantic_text, re.IGNORECASE) for value in values)
    if kind == "git_origin_regex":
        return any(re.search(value, record.git_origin_url, re.IGNORECASE) for value in values)
    return False


def current_project_name(
    thread_id: str, state: dict[str, Any], project_name_by_id: dict[str, str]
) -> str | None:
    assignment = state.get(STATE_ASSIGNMENTS_KEY, {}).get(thread_id)
    if not isinstance(assignment, dict):
        return None
    return project_name_by_id.get(assignment.get("projectId"))


def direct_decision(
    record: ThreadRecord,
    state: dict[str, Any],
    policy: dict[str, Any],
    project_name_by_id: dict[str, str],
) -> Decision:
    evidence: list[Evidence] = []
    projectless_reason = policy.get("projectlessOverrides", {}).get(record.thread_id)
    if projectless_reason is not None:
        return Decision(
            record.thread_id,
            "projectless",
            None,
            (),
            projectless_reason=projectless_reason,
        )
    override = policy.get("threadOverrides", {}).get(record.thread_id)
    if override is not None:
        evidence.append(
            Evidence(
                project_name=override["project"],
                priority=100,
                confirmation_state="confirmed",
                rule_id="thread-override",
                reason=override["reason"],
            )
        )
    for rule in policy.get("rules", []):
        if rule_matches(rule, record):
            evidence.append(
                Evidence(
                    project_name=rule["project"],
                    priority=rule["priority"],
                    confirmation_state=rule["confirmationState"],
                    rule_id=rule["id"],
                    reason=rule.get("reason", rule["id"]),
                )
            )
    existing = current_project_name(record.thread_id, state, project_name_by_id)
    if existing is not None and policy.get("preserveExisting", True):
        evidence.append(
            Evidence(
                project_name=existing,
                priority=int(policy.get("existingAssignmentPriority", 50)),
                confirmation_state="confirmed",
                rule_id="existing-assignment",
                reason="Existing Codex project assignment",
            )
        )
    if not evidence:
        return Decision(record.thread_id, "unclassified", None, ())
    top_priority = max(item.priority for item in evidence)
    top = tuple(item for item in evidence if item.priority == top_priority)
    top_projects = {item.project_name for item in top}
    if len(top_projects) != 1 or any(item.confirmation_state != "confirmed" for item in top):
        return Decision(record.thread_id, "candidate", None, top)
    return Decision(record.thread_id, "confirmed", next(iter(top_projects)), top)


def classify_threads(
    threads: list[ThreadRecord], state: dict[str, Any], policy: dict[str, Any]
) -> dict[str, Decision]:
    project_name_by_id = {
        project_id: project["name"]
        for project_id, project in state["local-projects"].items()
        if isinstance(project, dict) and isinstance(project.get("name"), str)
    }
    decisions = {
        record.thread_id: direct_decision(record, state, policy, project_name_by_id)
        for record in threads
    }
    records_by_id = {record.thread_id: record for record in threads}
    changed = True
    while changed:
        changed = False
        for record in threads:
            decision = decisions[record.thread_id]
            if decision.status == "confirmed":
                continue
            parent_id = parent_thread_id(record)
            parent = decisions.get(parent_id) if parent_id else None
            if parent is None or parent.status != "confirmed" or parent.project_name is None:
                continue
            # A confirmed direct candidate conflict remains reviewable. Parent inheritance is
            # only used for child-agent records without stronger confirmed evidence.
            direct_priorities = [item.priority for item in decision.evidence]
            if direct_priorities and max(direct_priorities) >= int(
                policy.get("parentInheritancePriority", 85)
            ):
                continue
            evidence = Evidence(
                project_name=parent.project_name,
                priority=int(policy.get("parentInheritancePriority", 85)),
                confirmation_state="confirmed",
                rule_id="parent-thread-inheritance",
                reason=f"Child-agent record inherits confirmed parent {parent_id}",
            )
            decisions[record.thread_id] = Decision(
                record.thread_id, "confirmed", parent.project_name, (evidence,)
            )
            changed = True
    # Keep static-analysis tools honest about the indexed record set.
    if len(records_by_id) != len(threads):
        raise ReconcileError("Duplicate thread IDs in Codex database")
    return decisions


def evidence_payload(evidence: Evidence) -> dict[str, Any]:
    return {
        "project": evidence.project_name,
        "priority": evidence.priority,
        "confirmationState": evidence.confirmation_state,
        "ruleId": evidence.rule_id,
        "reason": evidence.reason,
    }


def build_plan(
    threads: list[ThreadRecord],
    decisions: dict[str, Decision],
    state: dict[str, Any],
    state_raw: bytes,
    policy: dict[str, Any],
    policy_path: Path,
    state_path: Path | None = None,
) -> dict[str, Any]:
    project_id_by_name = {
        name: spec["projectId"] for name, spec in policy["projects"].items()
    }
    project_name_by_id = {value: key for key, value in project_id_by_name.items()}
    assignments = state.get(STATE_ASSIGNMENTS_KEY, {})
    confirmed: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    unclassified: list[dict[str, Any]] = []
    intentionally_projectless: list[dict[str, Any]] = []
    counts = Counter()
    project_counts = Counter()
    for record in sorted(threads, key=lambda item: (item.created_at, item.thread_id)):
        decision = decisions[record.thread_id]
        current = current_project_name(record.thread_id, state, project_name_by_id)
        if decision.status == "confirmed" and decision.project_name is not None:
            target_id = project_id_by_name[decision.project_name]
            operation = (
                "add"
                if record.thread_id not in assignments
                else "keep"
                if isinstance(assignments[record.thread_id], dict)
                and assignments[record.thread_id].get("projectId") == target_id
                else "move"
            )
            counts[operation] += 1
            project_counts[decision.project_name] += 1
            confirmed.append(
                {
                    "threadId": record.thread_id,
                    "targetProject": decision.project_name,
                    "targetProjectId": target_id,
                    "currentProject": current,
                    "operation": operation,
                    "archived": record.archived,
                    "createdAt": record.created_at,
                    "cwd": record.cwd,
                    "titleDigest": record.title_digest,
                    "evidence": [evidence_payload(item) for item in decision.evidence],
                }
            )
        elif decision.status == "projectless":
            projectless_ids = state.get(PROJECTLESS_IDS_KEY, [])
            has_assignment = record.thread_id in assignments
            is_explicit_projectless = (
                isinstance(projectless_ids, list) and record.thread_id in projectless_ids
            )
            operation = (
                "remove-assignment"
                if has_assignment
                else "keep"
                if is_explicit_projectless
                else "add"
            )
            counts[f"projectless-{operation}"] += 1
            intentionally_projectless.append(
                {
                    "threadId": record.thread_id,
                    "operation": operation,
                    "currentProject": current,
                    "archived": record.archived,
                    "createdAt": record.created_at,
                    "cwd": record.cwd,
                    "titleDigest": record.title_digest,
                    "reason": decision.projectless_reason,
                }
            )
        elif decision.status == "candidate":
            counts["candidate"] += 1
            candidates.append(
                {
                    "threadId": record.thread_id,
                    "currentProject": current,
                    "archived": record.archived,
                    "createdAt": record.created_at,
                    "cwd": record.cwd,
                    "titleDigest": record.title_digest,
                    "evidence": [evidence_payload(item) for item in decision.evidence],
                }
            )
        else:
            counts["unclassified"] += 1
            unclassified.append(
                {
                    "threadId": record.thread_id,
                    "currentProject": current,
                    "archived": record.archived,
                    "createdAt": record.created_at,
                    "cwd": record.cwd,
                    "titleDigest": record.title_digest,
                }
            )
    policy_raw = policy_path.read_bytes()
    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "statePath": str(
                state_path or Path.home() / ".codex" / ".codex-global-state.json"
            ),
            "stateSha256": sha256_bytes(state_raw),
            "policyPath": str(policy_path),
            "policySha256": sha256_bytes(policy_raw),
        },
        "summary": {
            "totalThreads": len(threads),
            "confirmedThreads": len(confirmed),
            "addedAssignments": counts["add"],
            "movedAssignments": counts["move"],
            "unchangedAssignments": counts["keep"],
            "candidateThreads": counts["candidate"],
            "unclassifiedThreads": counts["unclassified"],
            "intentionallyProjectlessThreads": len(intentionally_projectless),
            "addedProjectlessMarkers": counts["projectless-add"],
            "removedProjectAssignments": counts["projectless-remove-assignment"],
            "confirmedByProject": dict(sorted(project_counts.items())),
        },
        "confirmed": confirmed,
        "intentionallyProjectless": intentionally_projectless,
        "candidates": candidates,
        "unclassified": unclassified,
    }


def write_plan(plan: dict[str, Any], output_path: Path | None) -> None:
    payload = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
    if output_path is None:
        sys.stdout.write(payload)
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(payload, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    state_path = Path(args.state).expanduser().resolve()
    database_path = Path(args.database).expanduser().resolve()
    policy_path = Path(args.policy).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve() if args.output else None
    try:
        state, state_raw = read_json_file(state_path)
        policy = load_policy(policy_path, state)
        threads = load_threads(database_path)
        decisions = classify_threads(threads, state, policy)
        plan = build_plan(
            threads, decisions, state, state_raw, policy, policy_path, state_path
        )
        write_plan(plan, output_path)
    except ReconcileError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

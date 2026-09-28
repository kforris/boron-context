#!/usr/bin/env python3
"""Plan and apply one authoritative GitHub PR state change through Boron's API.

No database access, model calls, GitHub writes, session creation or automatic
scheduling. A plan binds an exact project, repository, PR and current relation
set. Apply re-reads both sources and submits one guarded activity transaction.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

VERSION = 1
MAX_BYTES = 2 * 1024 * 1024
STATE_TYPES = ("GITHUB_PR_OPEN", "GITHUB_PR_CLOSED", "GITHUB_PR_MERGED")
LEGACY_TYPE = "AWAITING_UPSTREAM_REVIEW"
MANAGED_TYPES = (*STATE_TYPES, LEGACY_TYPE)


class ReconcileError(RuntimeError):
    """A source, scope or concurrency check prevented reconciliation."""


class ApplyUnverified(ReconcileError):
    """A write was attempted; retain a receipt even if final verification failed."""

    def __init__(self, message: str, receipt: dict):
        super().__init__(message)
        self.receipt = receipt


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value: Any, name: str, observed: str) -> str:
    if not isinstance(value, str):
        raise ReconcileError(f"Missing {name}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        reference = datetime.fromisoformat(observed.replace("Z", "+00:00"))
        if parsed.tzinfo is None or (parsed - reference).total_seconds() > 300:
            raise ValueError()
    except ValueError as exc:
        raise ReconcileError(f"Invalid or future {name}") from exc
    return value


def scope(project_hint: str, project_id: str, repository: str, number: int) -> dict:
    if not project_hint.strip() or len(project_hint) > 1000:
        raise ReconcileError("An explicit project hint is required")
    try:
        UUID(project_id)
    except (ValueError, AttributeError) as exc:
        raise ReconcileError("An exact project UUID is required") from exc
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", repository):
        raise ReconcileError("Repository must be an exact GitHub owner/repository")
    if type(number) is not int or number < 1 or number > 2_147_483_647:
        raise ReconcileError("PR number must be a positive integer")
    return {"projectHint": project_hint, "projectId": project_id,
            "repository": repository, "number": number}


def normalize_source(raw: dict, target: dict, observed: str) -> dict:
    expected_url = f"https://github.com/{target['repository']}/pull/{target['number']}"
    base = raw.get("base")
    repository = base.get("repo") if isinstance(base, dict) else None
    if (type(raw.get("number")) is not int or raw.get("number") != target["number"]
            or raw.get("html_url") != expected_url or not isinstance(repository, dict)
            or repository.get("full_name") != target["repository"]):
        raise ReconcileError("GitHub PR identity does not match the exact repository and number")
    state, merged = raw.get("state"), raw.get("merged")
    if state not in ("open", "closed") or type(merged) is not bool:
        raise ReconcileError("Unknown GitHub PR state")
    if merged and (state != "closed" or not raw.get("merged_at")):
        raise ReconcileError("Inconsistent GitHub merged state")
    if not merged and raw.get("merged_at") is not None:
        raise ReconcileError("Inconsistent GitHub merge timestamp")
    if (state == "closed") != bool(raw.get("closed_at")):
        raise ReconcileError("Inconsistent GitHub closed timestamp")
    result = {"number": raw["number"], "url": expected_url,
              "repository": target["repository"],
              "state": "MERGED" if merged else state.upper(),
              "updatedAt": timestamp(raw.get("updated_at"), "updated_at", observed),
              "mergedAt": raw.get("merged_at"), "closedAt": raw.get("closed_at")}
    for field in ("mergedAt", "closedAt"):
        if result[field] is not None:
            timestamp(result[field], field, observed)
    return result


def entity(node: dict) -> dict:
    result = {key: node.get(key) for key in ("kind", "name", "canonicalUri")}
    if any(not isinstance(value, str) or not value.strip() for value in result.values()):
        raise ReconcileError("Ontology entity has incomplete identity")
    return result


def snapshot(graph: dict, target: dict) -> dict:
    project = graph.get("project")
    if not isinstance(project, dict) or project.get("id") != target["projectId"]:
        raise ReconcileError("Boron project did not resolve to the exact expected project UUID")
    nodes, edges = graph.get("nodes"), graph.get("edges")
    if (not isinstance(nodes, list) or not isinstance(edges, list)
            or any(not isinstance(row, dict) for row in [*nodes, *edges])):
        raise ReconcileError("Invalid ontology snapshot")
    # Inspector's bounded graph has no completeness flag. Refuse at either cap.
    if len(nodes) >= 500 or len(edges) >= 1000:
        raise ReconcileError("Ontology graph may be truncated; an exact relation snapshot is required")
    repo_url = f"https://github.com/{target['repository']}"
    pr_url = f"{repo_url}/pull/{target['number']}"
    selected = []
    for uri, kind in ((pr_url, "pull_request"), (repo_url, "repository")):
        matches = [node for node in nodes if node.get("canonicalUri") == uri]
        if len(matches) != 1:
            raise ReconcileError(f"Expected one existing ontology entity: {uri}")
        node = matches[0]
        try:
            UUID(node["id"])
        except (KeyError, ValueError, TypeError, AttributeError) as exc:
            raise ReconcileError("Ontology entity has incomplete identity") from exc
        if node.get("projectId") != target["projectId"] or node.get("kind") != kind:
            raise ReconcileError("Ontology entity kind/project does not match the requested scope")
        if node.get("confirmationState") != "confirmed":
            raise ReconcileError("Ontology identity must already be confirmed")
        selected.append(node)
    subject, repository = selected
    relations = []
    for edge in edges:
        if edge.get("source") != subject["id"] or edge.get("relationType") not in MANAGED_TYPES:
            continue
        if edge.get("target") != repository["id"]:
            raise ReconcileError("PR has a managed state relation to a different repository")
        if edge.get("confirmationState") not in ("candidate", "confirmed"):
            raise ReconcileError("Unknown relation confirmation state")
        try:
            UUID(edge["id"])
            timestamp(edge["validFrom"], "relation validFrom", now())
            relations.append({key: edge[key] for key in
                              ("id", "relationType", "confirmationState", "validFrom")})
        except (KeyError, ValueError, TypeError, AttributeError) as exc:
            raise ReconcileError("Incomplete active relation identity") from exc
    if len(relations) > 40 or len({r["id"] for r in relations}) != len(relations):
        raise ReconcileError("Ambiguous or excessive active PR state relations")
    return {"subject": entity(subject), "repository": entity(repository),
            "relations": sorted(relations, key=lambda item: item["id"])}


def effects_for(source: dict, current: dict) -> list[dict]:
    desired = f"GITHUB_PR_{source['state']}"
    stale_types = {r["relationType"] for r in current["relations"]
                   if r["relationType"] != desired
                   and (r["relationType"] != LEGACY_TYPE or source["state"] != "OPEN")}
    effects = []
    rationale = (f"Exact GitHub PR read reports {source['state']}; "
                 f"source updatedAt={source['updatedAt']}; {source['url']}")
    common = {"subject": current["subject"], "target": current["repository"],
              "confidence": 1, "confirmationState": "confirmed",
              "authority": "deterministic_source", "rationale": rationale}
    for relation_type in sorted(stale_types):
        effects.append({**common, "relationType": relation_type, "operation": "retract"})
    desired_rows = [r for r in current["relations"] if r["relationType"] == desired]
    if len(desired_rows) > 1:
        raise ReconcileError("Duplicate desired state relations require review")
    if not desired_rows or desired_rows[0]["confirmationState"] != "confirmed":
        effects.append({**common, "relationType": desired, "operation": "assert"})
    return effects


def make_plan(target: dict, raw: dict, graph: dict, observed: str) -> dict:
    source = normalize_source(raw, target, observed)
    current = snapshot(graph, target)
    plan = {"version": VERSION, "kind": "github_pr_state_reconciliation", "scope": target,
            "observedAt": observed, "source": source, "before": current,
            "relationEffects": effects_for(source, current)}
    plan["planDigest"] = digest(plan)
    return plan


def validate_plan(plan: dict) -> dict:
    if plan.get("version") != VERSION or plan.get("kind") != "github_pr_state_reconciliation":
        raise ReconcileError("Unsupported plan")
    unsigned = {key: value for key, value in plan.items() if key != "planDigest"}
    if digest(unsigned) != plan.get("planDigest"):
        raise ReconcileError("Plan digest mismatch")
    try:
        target = scope(plan["scope"]["projectHint"], plan["scope"]["projectId"],
                       plan["scope"]["repository"], plan["scope"]["number"])
        if target != plan["scope"] or effects_for(plan["source"], plan["before"]) != plan["relationEffects"]:
            raise ReconcileError("Plan is inconsistent with the reconciliation policy")
        timestamp(plan["observedAt"], "plan observedAt", now())
    except (KeyError, TypeError, AttributeError) as exc:
        raise ReconcileError("Malformed plan") from exc
    return target


def activity_for(plan: dict, session_id: str, observed: str) -> dict:
    try:
        UUID(session_id)
    except ValueError as exc:
        raise ReconcileError("An existing scoped session UUID is required") from exc
    source, target = plan["source"], plan["scope"]
    return {"sessionId": session_id, "projectHint": target["projectHint"],
            "activityType": "github.pull_request.state_reconciled",
            "summary": f"Verified {target['repository']} PR #{target['number']} is {source['state']} on GitHub; reconciled current PR state relations.",
            "targetUri": source["url"], "occurredAt": observed, "confidence": 1,
            "idempotencyKey": f"github-pr-reconcile-v1:{plan['planDigest']}",
            "metadata": {"reconciliationVersion": VERSION, "planDigest": plan["planDigest"],
                         "observedAt": observed, "source": source},
            "relationPreconditions": [{
                "subjectUri": plan["before"]["subject"]["canonicalUri"],
                "relationTypes": list(MANAGED_TYPES),
                "expectedRelationIds": [r["id"] for r in plan["before"]["relations"]]}],
            "relationEffects": plan["relationEffects"],
            "evidence": [{"layer": "ontology", "title": "Verified GitHub PR state",
                          "uri": source["url"], "confidence": 1, "authority": 1,
                          "excerpt": canonical(source),
                          "metadata": {"sourceAuthority": "deterministic_source",
                                       "observedAt": observed, "sourceUpdatedAt": source["updatedAt"]}}]}


def fetch_github(target: dict) -> dict:
    query = "{number,html_url,state,merged,merged_at,closed_at,updated_at,base:{repo:{full_name:.base.repo.full_name}}}"
    try:
        result = subprocess.run(["gh", "api", "--hostname", "github.com", "--method", "GET",
                                 f"repos/{target['repository']}/pulls/{target['number']}", "--jq", query],
                                capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReconcileError("GitHub read unavailable; no mutation attempted") from exc
    if result.returncode != 0:
        raise ReconcileError("GitHub read failed; no mutation attempted")
    return decode_json(result.stdout)


def decode_json(raw: str | bytes) -> dict:
    if len(raw) > MAX_BYTES:
        raise ReconcileError("Response exceeds the bounded JSON size")
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ReconcileError("Invalid JSON response") from exc
    if not isinstance(result, dict):
        raise ReconcileError("Expected a JSON object")
    return result


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        raise ReconcileError("Boron redirects are not allowed")


class BoronClient:
    def __init__(self, base_url: str, token: str):
        parsed = urlsplit(base_url)
        if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ReconcileError("Boron URL must be a credential-free loopback HTTP origin")
        if not token or "\n" in token or "\r" in token:
            raise ReconcileError("Missing or invalid Boron token")
        self.base_url, self.token = base_url.rstrip("/"), token
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, route: str, body: dict | None = None) -> dict:
        request = Request(self.base_url + route, data=canonical(body).encode() if body is not None else None,
                          method="POST" if body is not None else "GET",
                          headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=30) as response:
                return decode_json(response.read(MAX_BYTES + 1))
        except HTTPError as exc:
            raise ReconcileError(f"Boron request rejected (HTTP {exc.code}); inspect daemon diagnostics") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise ReconcileError("Boron request unavailable; if a write was sent, re-read state before retrying") from exc

    def post(self, route: str, body: dict) -> dict:
        return self.request(route, body)

    def require_guarded_writeback(self) -> None:
        health = self.request("/health")
        if health.get("capabilities", {}).get("relationPreconditions") != 1:
            raise ReconcileError("Daemon does not advertise guarded relation writeback; upgrade before applying")

    def graph(self, target: dict) -> dict:
        return self.post("/v1/inspector/ontology", {"projectHint": target["projectHint"]})


def apply_plan(plan: dict, session_id: str, client: BoronClient, fetch=fetch_github) -> dict:
    target = validate_plan(plan)
    observed = now()
    fresh = make_plan(target, fetch(target), client.graph(target), observed)
    if fresh["source"] != plan["source"]:
        raise ReconcileError("GitHub changed since review; create a new plan")
    if not fresh["relationEffects"]:
        return {"status": "already_current", "planDigest": plan["planDigest"], "writes": 0}
    if fresh["before"] != plan["before"] or fresh["relationEffects"] != plan["relationEffects"]:
        raise ReconcileError("Ontology changed since review; create a new plan")
    client.require_guarded_writeback()
    receipt = {"status": "write_not_verified", "planDigest": plan["planDigest"],
               "scope": target, "writes": "unknown", "observedAt": observed,
               "idempotencyKey": f"github-pr-reconcile-v1:{plan['planDigest']}"}
    try:
        response = client.post("/v1/activity/record", activity_for(plan, session_id, observed))
    except ReconcileError as exc:
        raise ApplyUnverified(str(exc), receipt) from exc
    receipt.update({"status": "applied_unverified", "writes": 1, "activity": response})
    try:
        verified = snapshot(client.graph(target), target)
        if effects_for(fresh["source"], verified):
            raise ReconcileError("Activity submitted but ontology readback does not match")
        final_source = normalize_source(fetch(target), target, now())
        if final_source != fresh["source"]:
            raise ReconcileError("GitHub changed during apply; re-plan from current sources")
    except ReconcileError as exc:
        raise ApplyUnverified(str(exc), receipt) from exc
    return {**receipt, "status": "applied_and_verified", "after": verified}


def token_from_environment() -> str:
    if os.environ.get("BORON_DAEMON_TOKEN"):
        return os.environ["BORON_DAEMON_TOKEN"].strip()
    default = (Path.home() / "Library/Application Support/Boron Context/daemon.token"
               if sys.platform == "darwin" else
               Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "boron-context/daemon.token")
    try:
        return Path(os.environ.get("BORON_TOKEN_FILE", str(default))).read_text().strip()
    except OSError as exc:
        raise ReconcileError("Unable to read Boron token file") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boron-url", default="http://127.0.0.1:41635")
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan_parser = subparsers.add_parser("plan", help="Read sources and produce a reviewable plan")
    for name in ("project-hint", "project-id", "repository"):
        plan_parser.add_argument("--" + name, required=True)
    plan_parser.add_argument("--number", required=True, type=int)
    apply_parser = subparsers.add_parser("apply", help="Revalidate sources and apply the exact plan")
    apply_parser.add_argument("--plan", required=True, type=Path)
    apply_parser.add_argument("--session-id", required=True)
    args = parser.parse_args(argv)
    try:
        client = BoronClient(args.boron_url, token_from_environment())
        if args.command == "plan":
            target = scope(args.project_hint, args.project_id, args.repository, args.number)
            result = make_plan(target, fetch_github(target), client.graph(target), now())
        else:
            result = apply_plan(decode_json(args.plan.read_bytes()), args.session_id, client)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except ApplyUnverified as exc:
        print(json.dumps(exc.receipt, ensure_ascii=False, indent=2))
        print(f"error: {exc}; preserve this receipt and re-read before retrying", file=sys.stderr)
        return 2
    except (ReconcileError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

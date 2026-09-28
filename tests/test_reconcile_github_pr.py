"""Regression coverage for bounded, source-verified PR state reconciliation."""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/reconcile_github_pr.py"
SPEC = importlib.util.spec_from_file_location("reconcile_github_pr", SCRIPT)
assert SPEC and SPEC.loader
reconcile = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reconcile)
SOURCE = json.loads((Path(__file__).parent / "fixtures/github-pr/build123d-1389-merged.json").read_text())
PROJECT_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
SUBJECT_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"
REPOSITORY_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc"
RELATION_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd"
NEW_RELATION_ID = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee"
SESSION_ID = "ffffffff-ffff-4fff-ffff-ffffffffffff"
OBSERVED = "2026-09-28T18:00:00Z"


def target():
    return reconcile.scope("build123d", PROJECT_ID, "gumyr/build123d", 1389)


def graph():
    # Synthetic ontology identities reproduce the real stale-state failure.
    return {"project": {"id": PROJECT_ID, "name": "build123d"},
            "nodes": [{"id": SUBJECT_ID, "projectId": PROJECT_ID, "kind": "pull_request",
                       "name": "build123d PR #1389", "canonicalUri": SOURCE["html_url"],
                       "confirmationState": "confirmed"},
                      {"id": REPOSITORY_ID, "projectId": PROJECT_ID, "kind": "repository",
                       "name": "gumyr/build123d", "canonicalUri": "https://github.com/gumyr/build123d",
                       "confirmationState": "confirmed"}],
            "edges": [{"id": RELATION_ID, "source": SUBJECT_ID, "target": REPOSITORY_ID,
                       "relationType": "AWAITING_UPSTREAM_REVIEW", "confirmationState": "confirmed",
                       "validFrom": "2026-08-02T05:54:15.271Z"}]}


class MemoryClient:
    def __init__(self, current=None):
        self.current = copy.deepcopy(current or graph())
        self.writes = []
        self.history = []
        self.capability = True

    def graph(self, _target):
        return copy.deepcopy(self.current)

    def require_guarded_writeback(self):
        if not self.capability:
            raise reconcile.ReconcileError("guarded relation writeback unavailable")

    def post(self, route, body):
        assert route == "/v1/activity/record"
        condition = body["relationPreconditions"][0]
        ids = [r["id"] for r in self.current["edges"] if r["relationType"] in condition["relationTypes"]]
        if sorted(ids) != sorted(condition["expectedRelationIds"]):
            raise reconcile.ReconcileError("relation_precondition_failed")
        self.writes.append(body)
        for effect in body["relationEffects"]:
            if effect["operation"] == "retract":
                rows = [r for r in self.current["edges"] if r["relationType"] == effect["relationType"]]
                self.history.extend({**r, "validTo": body["occurredAt"]} for r in rows)
                self.current["edges"] = [r for r in self.current["edges"] if r not in rows]
            else:
                rows = [r for r in self.current["edges"] if r["relationType"] == effect["relationType"]]
                if rows:
                    rows[0]["confirmationState"] = "confirmed"
                else:
                    self.current["edges"].append({"id": NEW_RELATION_ID, "source": SUBJECT_ID,
                                                  "target": REPOSITORY_ID, "relationType": effect["relationType"],
                                                  "confirmationState": "confirmed", "validFrom": body["occurredAt"]})
        return {"id": "activity-fixture", "relationEffects": len(body["relationEffects"]), "duplicate": False}


class ReconcileGithubPrTests(unittest.TestCase):
    def setUp(self):
        clock = mock.patch.object(reconcile, "now", return_value=OBSERVED)
        clock.start()
        self.addCleanup(clock.stop)

    def plan(self, source=None, current=None):
        return reconcile.make_plan(target(), source or SOURCE, current or graph(), OBSERVED)

    def test_real_merged_pr_replaces_waiting_relation_in_one_activity(self):
        plan = self.plan()
        self.assertEqual([(e["operation"], e["relationType"]) for e in plan["relationEffects"]],
                         [("retract", "AWAITING_UPSTREAM_REVIEW"), ("assert", "GITHUB_PR_MERGED")])
        client = MemoryClient()
        result = reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        self.assertEqual(result["status"], "applied_and_verified")
        self.assertEqual(len(client.writes), 1)
        payload = client.writes[0]
        self.assertEqual(payload["relationPreconditions"][0]["expectedRelationIds"], [RELATION_ID])
        self.assertEqual(payload["metadata"]["source"]["mergedAt"], "2026-08-04T16:08:53Z")
        self.assertNotEqual(payload["occurredAt"], SOURCE["merged_at"])
        self.assertEqual(client.history[0]["id"], RELATION_ID)
        self.assertTrue(all(effect["authority"] == "deterministic_source" for effect in payload["relationEffects"]))

    def test_repeat_apply_is_noop_without_duplicate_retraction_or_activity(self):
        client, plan = MemoryClient(), self.plan()
        reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        result = reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        self.assertEqual(result["status"], "already_current")
        self.assertEqual(len(client.writes), 1)
        self.assertEqual(len(client.history), 1)

    def test_unknown_inconsistent_and_wrong_identity_sources_fail(self):
        cases = [{"state": "unknown"}, {"merged": False}, {"number": 1390},
                 {"html_url": "https://github.com/other/repo/pull/1389"},
                 {"base": {"repo": {"full_name": "other/repo"}}}, {"closed_at": None},
                 {"updated_at": "invalid"}, {"updated_at": "2099-01-01T00:00:00Z"}]
        for fields in cases:
            with self.subTest(fields=fields), self.assertRaises(reconcile.ReconcileError):
                self.plan(source={**SOURCE, **fields})

    def test_source_change_and_ontology_change_prevent_write(self):
        client, plan = MemoryClient(), self.plan()
        with self.assertRaisesRegex(reconcile.ReconcileError, "GitHub changed"):
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: {**SOURCE, "updated_at": "2026-09-01T00:00:00Z"})
        client.current["edges"][0]["id"] = NEW_RELATION_ID
        with self.assertRaisesRegex(reconcile.ReconcileError, "Ontology changed"):
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        self.assertEqual(client.writes, [])

    def test_project_unknown_cross_project_or_unconfirmed_identity_is_rejected(self):
        for field in ("project", "node_project", "confirmation", "missing", "kind"):
            current = graph()
            if field == "project": current["project"] = None
            if field == "node_project": current["nodes"][0]["projectId"] = REPOSITORY_ID
            if field == "confirmation": current["nodes"][0]["confirmationState"] = "candidate"
            if field == "missing": current["nodes"].pop()
            if field == "kind": current["nodes"][0]["kind"] = "issue"
            with self.subTest(field=field), self.assertRaises(reconcile.ReconcileError):
                self.plan(current=current)

    def test_truncation_and_state_relation_to_wrong_repository_are_rejected(self):
        current = graph()
        current["nodes"] += [current["nodes"][0]] * 498
        with self.assertRaisesRegex(reconcile.ReconcileError, "truncated"):
            self.plan(current=current)
        current = graph()
        current["edges"][0]["target"] = PROJECT_ID
        with self.assertRaisesRegex(reconcile.ReconcileError, "different repository"):
            self.plan(current=current)

    def test_open_state_does_not_infer_review_status(self):
        source = {**SOURCE, "state": "open", "merged": False, "merged_at": None, "closed_at": None}
        plan = self.plan(source=source)
        self.assertEqual([(e["operation"], e["relationType"]) for e in plan["relationEffects"]],
                         [("assert", "GITHUB_PR_OPEN")])
        current = graph()
        current["edges"][0]["relationType"] = "GITHUB_PR_CLOSED"
        plan = self.plan(source=source, current=current)
        self.assertEqual(plan["relationEffects"][0]["operation"], "retract")
        self.assertEqual(plan["relationEffects"][1]["relationType"], "GITHUB_PR_OPEN")

    def test_closed_without_merge_uses_closed_state(self):
        plan = self.plan(source={**SOURCE, "merged": False, "merged_at": None})
        self.assertEqual(plan["relationEffects"][-1]["relationType"], "GITHUB_PR_CLOSED")

    def test_unavailable_source_and_old_daemon_never_write(self):
        client, plan = MemoryClient(), self.plan()
        with self.assertRaises(reconcile.ReconcileError):
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=mock.Mock(side_effect=reconcile.ReconcileError("offline")))
        client.capability = False
        with self.assertRaisesRegex(reconcile.ReconcileError, "guarded"):
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        self.assertEqual(client.writes, [])

    def test_tampered_plan_is_rejected_even_with_recomputed_digest(self):
        plan = self.plan()
        plan["relationEffects"][0]["target"]["canonicalUri"] = "https://github.com/other/repo"
        with self.assertRaises(reconcile.ReconcileError):
            reconcile.validate_plan(plan)
        # Stored entities share no trust: apply always compares against the live graph.
        plan["planDigest"] = reconcile.digest({k: v for k, v in plan.items() if k != "planDigest"})
        client = MemoryClient()
        with self.assertRaises(reconcile.ReconcileError):
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        self.assertEqual(client.writes, [])

    def test_cas_conflict_after_read_is_not_reported_as_success(self):
        client, plan = MemoryClient(), self.plan()
        client.require_guarded_writeback = lambda: client.current["edges"][0].update({"id": NEW_RELATION_ID})
        with self.assertRaises(reconcile.ApplyUnverified) as raised:
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        self.assertEqual(raised.exception.receipt["status"], "write_not_verified")
        self.assertEqual(client.writes, [])

    def test_source_change_after_write_retains_unverified_activity_receipt(self):
        client, plan = MemoryClient(), self.plan()
        fetch = mock.Mock(side_effect=[SOURCE, {**SOURCE, "updated_at": "2026-09-01T00:00:00Z"}])
        with self.assertRaises(reconcile.ApplyUnverified) as raised:
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=fetch)
        receipt = raised.exception.receipt
        self.assertEqual(receipt["status"], "applied_unverified")
        self.assertEqual(receipt["activity"]["id"], "activity-fixture")
        self.assertEqual(receipt["planDigest"], plan["planDigest"])
        self.assertEqual(len(client.writes), 1)

    def test_readback_outage_preserves_activity_receipt(self):
        client, plan = MemoryClient(), self.plan()
        client.graph = mock.Mock(side_effect=[graph(), reconcile.ReconcileError("offline")])
        with self.assertRaises(reconcile.ApplyUnverified) as raised:
            reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)
        self.assertEqual(raised.exception.receipt["activity"]["id"], "activity-fixture")

    def test_candidate_desired_relation_is_confirmed_by_authoritative_source(self):
        current = graph()
        current["edges"][0].update({"relationType": "GITHUB_PR_MERGED", "confirmationState": "candidate"})
        plan = self.plan(current=current)
        self.assertEqual(len(plan["relationEffects"]), 1)
        self.assertEqual(plan["relationEffects"][0]["operation"], "assert")
        client = MemoryClient(current)
        self.assertEqual(reconcile.apply_plan(plan, SESSION_ID, client, fetch=lambda _: SOURCE)["status"],
                         "applied_and_verified")

    def test_source_command_pins_hostname_and_uses_no_shell(self):
        with mock.patch.object(reconcile.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=json.dumps(SOURCE))) as run:
            self.assertEqual(reconcile.fetch_github(target()), SOURCE)
            argv = run.call_args.args[0]
            self.assertIn("github.com", argv)
            self.assertIn("repos/gumyr/build123d/pulls/1389", argv)
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_credentials_cannot_be_sent_to_remote_origin(self):
        for url in ("https://example.com", "http://localhost.evil", "http://user@127.0.0.1", "http://127.0.0.1/api"):
            with self.subTest(url=url), self.assertRaises(reconcile.ReconcileError):
                reconcile.BoronClient(url, "token")

    def test_complete_cli_plan_apply_readback_uses_http_and_gh_boundaries(self):
        client = MemoryClient()
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond({"capabilities": {"relationPreconditions": 1}})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append((self.path, body))
                if self.headers.get("Authorization") != "Bearer fixture-token":
                    self.send_error(401)
                    return
                self.respond(client.graph(target()) if self.path.endswith("ontology") else client.post(self.path, body))

            def respond(self, body):
                raw = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                gh = root / "gh"
                gh.write_text(f"#!{sys.executable}\nimport json\nprint({json.dumps(SOURCE)!r})\n")
                gh.chmod(0o700)
                env = {**os.environ, "BORON_DAEMON_TOKEN": "fixture-token", "PATH": str(root) + os.pathsep + os.environ["PATH"]}
                base = [sys.executable, str(SCRIPT), "--boron-url", f"http://127.0.0.1:{server.server_port}"]
                planned = subprocess.run(base + ["plan", "--project-hint", "build123d", "--project-id", PROJECT_ID,
                                                 "--repository", "gumyr/build123d", "--number", "1389"],
                                         env=env, capture_output=True, text=True, check=True)
                self.assertEqual(client.writes, [])
                plan_path = root / "plan.json"
                plan_path.write_text(planned.stdout)
                applied = subprocess.run(base + ["apply", "--plan", str(plan_path), "--session-id", SESSION_ID],
                                         env=env, capture_output=True, text=True, check=True)
                self.assertEqual(json.loads(applied.stdout)["status"], "applied_and_verified")
                self.assertEqual(len(client.writes), 1)
                self.assertEqual(sum(route.endswith("ontology") for route, _ in calls), 3)
                self.assertEqual(client.current["edges"][0]["relationType"], "GITHUB_PR_MERGED")
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()

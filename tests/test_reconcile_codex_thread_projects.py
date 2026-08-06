from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "reconcile_codex_thread_projects.py"
SPEC = importlib.util.spec_from_file_location("codex_thread_reconciler", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CodexThreadReconcilerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state_path = self.root / ".codex-global-state.json"
        self.database_path = self.root / "state_5.sqlite"
        self.policy_path = self.root / "policy.json"
        self.project_ids = {
            "Boron Content": "19ed250e-e715-4343-9c2a-fd6bdf49e013",
            "Marketing & Branding": "08ed7213-45ca-4f9c-b9a8-fcbe6750e391",
        }
        self.state = {
            "local-projects": {
                project_id: {"id": project_id, "name": name, "rootPaths": []}
                for name, project_id in self.project_ids.items()
            },
            "thread-project-assignments": {},
            "projectless-thread-ids": [],
        }
        self.state_path.write_text(json.dumps(self.state), encoding="utf-8")
        self._create_database()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _create_database(self) -> None:
        connection = sqlite3.connect(self.database_path)
        connection.execute(
            """
            CREATE TABLE threads (
              id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
              first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
              source TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              git_origin_url TEXT, agent_path TEXT
            )
            """
        )
        connection.executemany(
            """
            INSERT INTO threads
            (id, cwd, title, first_user_message, preview, source, archived,
             created_at, updated_at, git_origin_url, agent_path)
            VALUES (?, ?, ?, '', '', ?, 0, ?, ?, NULL, ?)
            """,
            [
                (
                    "root-boron",
                    "/workspace/Boron-Context",
                    "Repair Boron Context",
                    "vscode",
                    1,
                    2,
                    None,
                ),
                (
                    "marketing",
                    "/workspace",
                    "Automation: review Automation ID: boron-marketing",
                    "vscode",
                    3,
                    4,
                    None,
                ),
                (
                    "child",
                    "/workspace",
                    "Inspect tests",
                    json.dumps(
                        {
                            "subagent": {
                                "thread_spawn": {"parent_thread_id": "root-boron"}
                            }
                        }
                    ),
                    5,
                    6,
                    "/root/tests",
                ),
                (
                    "ambiguous",
                    "/workspace",
                    "Boron marketing integration",
                    "vscode",
                    7,
                    8,
                    None,
                ),
                (
                    "unknown",
                    "/workspace",
                    "hello",
                    "vscode",
                    9,
                    10,
                    None,
                ),
            ],
        )
        connection.commit()
        connection.close()

    def _write_policy(self) -> dict:
        policy = {
            "version": 1,
            "authority": "user_approved",
            "preserveExisting": True,
            "projects": {
                name: {"projectId": project_id}
                for name, project_id in self.project_ids.items()
            },
            "rules": [
                {
                    "id": "boron-root",
                    "project": "Boron Content",
                    "kind": "cwd_prefix",
                    "values": ["/workspace/Boron-Context"],
                    "priority": 90,
                    "confirmationState": "confirmed",
                },
                {
                    "id": "marketing-automation",
                    "project": "Marketing & Branding",
                    "kind": "automation_id",
                    "values": ["boron-marketing"],
                    "priority": 95,
                    "confirmationState": "confirmed",
                },
                {
                    "id": "boron-word",
                    "project": "Boron Content",
                    "kind": "text_contains",
                    "values": ["boron"],
                    "priority": 70,
                    "confirmationState": "confirmed",
                },
                {
                    "id": "marketing-word",
                    "project": "Marketing & Branding",
                    "kind": "text_contains",
                    "values": ["marketing"],
                    "priority": 70,
                    "confirmationState": "confirmed",
                },
            ],
            "threadOverrides": {},
            "projectlessOverrides": {},
        }
        self.policy_path.write_text(json.dumps(policy), encoding="utf-8")
        return policy

    def test_confirmed_candidate_unclassified_and_parent_inheritance(self) -> None:
        policy = self._write_policy()
        state, _ = MODULE.read_json_file(self.state_path)
        policy = MODULE.load_policy(self.policy_path, state)
        threads = MODULE.load_threads(self.database_path)
        decisions = MODULE.classify_threads(threads, state, policy)
        self.assertEqual(decisions["root-boron"].project_name, "Boron Content")
        self.assertEqual(decisions["marketing"].project_name, "Marketing & Branding")
        self.assertEqual(decisions["child"].project_name, "Boron Content")
        self.assertEqual(decisions["ambiguous"].status, "candidate")
        self.assertEqual(decisions["unknown"].status, "unclassified")

    def test_plan_is_read_only_and_contains_only_review_outputs(self) -> None:
        policy = self._write_policy()
        self.state["projectless-thread-ids"] = ["root-boron", "unknown"]
        self.state_path.write_text(json.dumps(self.state), encoding="utf-8")
        original = self.state_path.read_bytes()
        state, raw = MODULE.read_json_file(self.state_path)
        policy = MODULE.load_policy(self.policy_path, state)
        threads = MODULE.load_threads(self.database_path)
        decisions = MODULE.classify_threads(threads, state, policy)
        plan = MODULE.build_plan(threads, decisions, state, raw, policy, self.policy_path)
        self.assertEqual(self.state_path.read_bytes(), original)
        self.assertEqual(plan["summary"]["confirmedThreads"], 3)
        self.assertEqual(plan["summary"]["candidateThreads"], 1)
        self.assertEqual(plan["summary"]["unclassifiedThreads"], 1)
        self.assertNotIn("Repair Boron Context", json.dumps(plan))
        self.assertNotIn("hello", json.dumps(plan))

    def test_explicit_projectless_override_is_auditable(self) -> None:
        policy = self._write_policy()
        policy["projectlessOverrides"] = {"unknown": "Greeting has no project signal"}
        self.policy_path.write_text(json.dumps(policy), encoding="utf-8")
        state, raw = MODULE.read_json_file(self.state_path)
        policy = MODULE.load_policy(self.policy_path, state)
        threads = MODULE.load_threads(self.database_path)
        decisions = MODULE.classify_threads(threads, state, policy)
        self.assertEqual(decisions["unknown"].status, "projectless")
        plan = MODULE.build_plan(threads, decisions, state, raw, policy, self.policy_path)
        self.assertEqual(plan["summary"]["intentionallyProjectlessThreads"], 1)
        self.assertEqual(plan["intentionallyProjectless"][0]["threadId"], "unknown")
        self.assertEqual(
            plan["intentionallyProjectless"][0]["reason"],
            "Greeting has no project signal",
        )


if __name__ == "__main__":
    unittest.main()

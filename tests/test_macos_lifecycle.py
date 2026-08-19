from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "macos_lifecycle.py"
SPEC = importlib.util.spec_from_file_location("macos_lifecycle", SCRIPT)
assert SPEC and SPEC.loader
macos_lifecycle = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = macos_lifecycle
SPEC.loader.exec_module(macos_lifecycle)


class MacosLifecycleTests(unittest.TestCase):
    def test_backup_is_non_overwriting_and_uses_a_private_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "backup.dump"

            def runner(arguments, **_kwargs):
                destination = Path(arguments[arguments.index("--file") + 1])
                destination.write_bytes(b"postgres-custom-fixture")
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch.object(macos_lifecycle, "require_command", return_value="pg_dump"):
                receipt = macos_lifecycle.backup_database(
                    "postgresql://127.0.0.1/boron_test", output, runner=runner
                )
                with self.assertRaises(FileExistsError):
                    macos_lifecycle.backup_database(
                        "postgresql://127.0.0.1/boron_test", output, runner=runner
                    )

            self.assertEqual(output.read_bytes(), b"postgres-custom-fixture")
            self.assertEqual(receipt["artifact"]["bytes"], 23)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_database_target_never_exposes_credentials_in_receipt_or_arguments(self) -> None:
        target = macos_lifecycle.PostgresTarget.parse(
            "postgresql://release-user:secret@127.0.0.1:55432/boron_test"
        )
        self.assertEqual(
            target.receipt_identity(),
            {"host": "127.0.0.1", "port": 55432, "database": "boron_test"},
        )
        self.assertNotIn("secret", " ".join(target.connection_arguments()))
        self.assertEqual(target.command_environment()["PGPASSWORD"], "secret")

    def test_restore_requires_confirmation_before_inspecting_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "backup.dump"
            backup.write_bytes(b"fixture")
            with self.assertRaisesRegex(RuntimeError, "confirm-empty-target"):
                macos_lifecycle.restore_database(
                    "postgresql://127.0.0.1/empty",
                    backup,
                    expected_sha256=None,
                    confirm_empty_target=False,
                )

    def test_restore_rejects_a_nonempty_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "backup.dump"
            backup.write_bytes(b"fixture")
            with mock.patch.object(macos_lifecycle, "database_object_count", return_value=2):
                with self.assertRaisesRegex(RuntimeError, "not empty"):
                    macos_lifecycle.restore_database(
                        "postgresql://127.0.0.1/not_empty",
                        backup,
                        expected_sha256=None,
                        confirm_empty_target=True,
                    )

    def test_uninstall_rejects_path_like_launchd_labels(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid launchd label"):
            macos_lifecycle.UninstallPaths(
                home=Path("/tmp/home"),
                codex_home=Path("/tmp/codex"),
                daemon_label="../../other",
                lan_label="dev.boroncontext.lan",
                menubar_label="dev.boroncontext.menu",
            )

    def test_uninstall_removes_runtime_surfaces_and_preserves_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            codex_home = root / "codex"
            paths = macos_lifecycle.UninstallPaths(
                home=home,
                codex_home=codex_home,
                daemon_label="dev.boroncontext.test.daemon",
                lan_label="dev.boroncontext.test.lan",
                menubar_label="dev.boroncontext.test.menu",
            )
            for plist in paths.launch_agents:
                plist.parent.mkdir(parents=True, exist_ok=True)
                plist.write_text("fixture", encoding="utf-8")
            paths.menu_app.mkdir(parents=True)
            for preserved in paths.preserved_paths:
                preserved.mkdir(parents=True)
                (preserved / "keep.txt").write_text("keep", encoding="utf-8")

            calls: list[list[str]] = []

            def runner(arguments, **_kwargs):
                calls.append(list(arguments))
                if arguments[1:4] == ["plugin", "list", "--json"]:
                    payload = {
                        "installed": [{"pluginId": "boron-context@boron-context"}]
                    }
                elif arguments[1:5] == ["plugin", "marketplace", "list", "--json"]:
                    payload = {"marketplaces": [{"name": "boron-context"}]}
                else:
                    payload = {}
                return mock.Mock(returncode=0, stdout=json.dumps(payload), stderr="")

            with mock.patch.object(macos_lifecycle.shutil, "which", return_value="/bin/tool"):
                receipt = macos_lifecycle.uninstall(
                    paths,
                    remove_codex=True,
                    remove_marketplace=True,
                    dry_run=False,
                    runner=runner,
                )

            self.assertTrue(all(not plist.exists() for plist in paths.launch_agents))
            self.assertFalse(paths.menu_app.exists())
            self.assertTrue(all((path / "keep.txt").exists() for path in paths.preserved_paths))
            self.assertEqual(receipt["databaseAction"], "none")
            self.assertEqual(len(calls), 7)

    def test_receipts_are_private_and_machine_readable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            macos_lifecycle.write_receipt(path, {"status": "completed"})
            self.assertEqual(json.loads(path.read_text()), {"status": "completed"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()

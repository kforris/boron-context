#!/usr/bin/env python3
"""Rehearse Boron Context install, upgrade, backup/restore, rollback, and uninstall.

The rehearsal uses a temporary HOME, CODEX_HOME, PostgreSQL cluster, daemon port, launchd labels,
menu application, and marketplace staging directory. It never points lifecycle commands at the
operator's production database or default Boron launch agents.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


DEFAULT_PREVIOUS_REF = "23fbd277c1575d0aa48b89744ed2974bc4350693"


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def command(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise RuntimeError(f"required command is unavailable: {name}")
    return resolved


def run(
    arguments: Sequence[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        list(arguments),
        cwd=cwd,
        env=env,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and result.returncode != 0:
        safe_command = " ".join(
            Path(item).name if index == 0 else item
            for index, item in enumerate(arguments)
        )
        raise RuntimeError(
            f"command failed ({result.returncode}): {safe_command}\n"
            f"stdout:\n{result.stdout[-4000:]}\nstderr:\n{result.stderr[-4000:]}"
        )
    return result


@dataclass
class StepLog:
    steps: list[dict[str, object]] = field(default_factory=list)

    def execute(self, name: str, action):
        started = time.monotonic()
        try:
            result = action()
        except Exception as error:
            self.steps.append(
                {
                    "name": name,
                    "status": "failed",
                    "durationSeconds": round(time.monotonic() - started, 3),
                    "error": str(error).splitlines()[0],
                }
            )
            raise
        self.steps.append(
            {
                "name": name,
                "status": "passed",
                "durationSeconds": round(time.monotonic() - started, 3),
            }
        )
        return result


@dataclass(frozen=True)
class RehearsalLayout:
    root: Path
    current: Path
    previous: Path
    home: Path
    codex_home: Path
    marketplace: Path
    pgdata: Path
    pglog: Path
    backup: Path
    receipt: Path
    uninstall_receipt: Path
    daemon_label: str
    lan_label: str
    menu_label: str
    daemon_port: int
    postgres_port: int

    @classmethod
    def create(cls, root: Path, current: Path, previous_ref: str) -> "RehearsalLayout":
        suffix = str(os.getpid())
        layout = cls(
            root=root,
            current=current,
            previous=root / "previous",
            home=root / "home",
            codex_home=root / "codex-home",
            marketplace=root / "marketplace",
            pgdata=root / "postgres",
            pglog=root / "postgres.log",
            backup=root / "boron-before-upgrade.dump",
            receipt=root / "lifecycle-rehearsal-receipt.json",
            uninstall_receipt=root / "uninstall-receipt.json",
            daemon_label=f"dev.boroncontext.rehearsal.{suffix}.daemon",
            lan_label=f"dev.boroncontext.rehearsal.{suffix}.lan",
            menu_label=f"dev.boroncontext.rehearsal.{suffix}.menu",
            daemon_port=available_port(),
            postgres_port=available_port(),
        )
        layout.home.mkdir(parents=True)
        layout.codex_home.mkdir(parents=True)
        return layout

    @property
    def database_url(self) -> str:
        return f"postgresql://127.0.0.1:{self.postgres_port}/boron_lifecycle"

    @property
    def restore_database_url(self) -> str:
        return f"postgresql://127.0.0.1:{self.postgres_port}/boron_lifecycle_restore"

    @property
    def menu_app(self) -> Path:
        return self.home / "Applications" / "Boron Meter.app"


def materialize_ref(repository: Path, ref: str, destination: Path) -> None:
    archive = destination.parent / "previous.tar"
    run([command("git"), "archive", "--format=tar", f"--output={archive}", ref], cwd=repository)
    destination.mkdir(parents=True)
    with tarfile.open(archive) as bundle:
        destination_root = destination.resolve()
        for member in bundle.getmembers():
            if member.issym() or member.islnk():
                raise RuntimeError(f"archive contains an unsupported link: {member.name}")
            member_path = (destination / member.name).resolve()
            if os.path.commonpath((destination_root, member_path)) != str(destination_root):
                raise RuntimeError(f"archive member escapes destination: {member.name}")
        bundle.extractall(destination)
    archive.unlink()


def apply_previous_release_isolation_shim(layout: RehearsalLayout) -> None:
    """Replace fixed pre-0.8 labels inside only the disposable extracted release."""
    cli = layout.previous / "src" / "cli.ts"
    cli_text = cli.read_text(encoding="utf-8")
    if "dev.boroncontext.daemon" not in cli_text or "dev.boroncontext.lan-mr" not in cli_text:
        raise RuntimeError("previous release no longer matches the fixed-label isolation shim")
    cli_text = cli_text.replace("dev.boroncontext.daemon", layout.daemon_label)
    cli_text = cli_text.replace("dev.boroncontext.lan-mr", layout.lan_label)
    cli.write_text(cli_text, encoding="utf-8")
    menu = layout.previous / "scripts" / "install_menubar.py"
    menu_text = menu.read_text(encoding="utf-8")
    if "dev.boroncontext.menubar" not in menu_text:
        raise RuntimeError("previous menu installer no longer matches the isolation shim")
    menu_text = menu_text.replace("dev.boroncontext.menubar", layout.menu_label)
    menu.write_text(menu_text, encoding="utf-8")


def prepare_source(source: Path) -> None:
    run([command("npm"), "ci"], cwd=source)
    run([command("npm"), "run", "build"], cwd=source)


def start_postgres(layout: RehearsalLayout) -> None:
    layout.pgdata.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            command("initdb"),
            "--pgdata",
            str(layout.pgdata),
            "--auth=trust",
            "--no-locale",
            "--encoding=UTF8",
        ]
    )
    run(
        [
            command("pg_ctl"),
            "--pgdata",
            str(layout.pgdata),
            "--log",
            str(layout.pglog),
            "--options",
            f"-F -p {layout.postgres_port}",
            "start",
            "--wait",
        ]
    )
    create_database(layout, "boron_lifecycle")
    create_database(layout, "boron_lifecycle_restore")


def stop_postgres(layout: RehearsalLayout) -> None:
    if layout.pgdata.exists():
        run(
            [command("pg_ctl"), "--pgdata", str(layout.pgdata), "stop", "--mode=fast", "--wait"],
            check=False,
        )


def create_database(layout: RehearsalLayout, database: str) -> None:
    run(
        [
            command("createdb"),
            "--host=127.0.0.1",
            f"--port={layout.postgres_port}",
            database,
        ]
    )


def drop_database(layout: RehearsalLayout, database: str) -> None:
    run(
        [
            command("dropdb"),
            "--host=127.0.0.1",
            f"--port={layout.postgres_port}",
            "--force",
            database,
        ]
    )


def psql(layout: RehearsalLayout, database: str, sql: str) -> str:
    result = run(
        [
            command("psql"),
            "--host=127.0.0.1",
            f"--port={layout.postgres_port}",
            f"--dbname={database}",
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--command",
            sql,
        ]
    )
    return result.stdout.strip()


def lifecycle_environment(layout: RehearsalLayout) -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "HOME": str(layout.home),
            "CODEX_HOME": str(layout.codex_home),
            "BORON_DATABASE_URL": layout.database_url,
            "BORON_HOST": "127.0.0.1",
            "BORON_PORT": str(layout.daemon_port),
            "BORON_LAUNCHD_LABEL": layout.daemon_label,
            "BORON_LAN_MR_LABEL": layout.lan_label,
            "BORON_MENUBAR_LABEL": layout.menu_label,
            "BORON_MENUBAR_APP_BUNDLE": str(layout.menu_app),
            "BORON_MENUBAR_LOG_ROOT": str(layout.root / "menu-logs"),
            "BORON_OPENWIKI_ROOT": str(layout.root / "openwiki"),
            "BORON_CODEBASE_MEMORY_COMMAND": "/usr/bin/false",
            "BORON_CODEBASE_MEMORY_GRAPH_URL": f"http://127.0.0.1:{available_port()}",
        }
    )
    return env


def wait_for_health(layout: RehearsalLayout, expected_version: str) -> dict[str, object]:
    url = f"http://127.0.0.1:{layout.daemon_port}/health"
    deadline = time.monotonic() + 20
    last_error = "not attempted"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                body = json.loads(response.read())
            if body.get("version") != expected_version:
                raise RuntimeError(
                    "health version mismatch: "
                    f"expected {expected_version}, got {body.get('version')}"
                )
            if not body.get("ok") or not body.get("database", {}).get("ok"):
                raise RuntimeError(f"daemon health failed: {body}")
            return body
        except (OSError, urllib.error.URLError, json.JSONDecodeError, RuntimeError) as error:
            last_error = str(error)
            time.sleep(0.25)
    raise RuntimeError(f"daemon did not become healthy: {last_error}")


def install_runtime(layout: RehearsalLayout, source: Path, expected_version: str) -> None:
    env = lifecycle_environment(layout)
    run([command("npm"), "run", "db:migrate"], cwd=source, env=env)
    run([command("npm"), "run", "service:install"], cwd=source, env=env)
    wait_for_health(layout, expected_version)


def install_menu(layout: RehearsalLayout, source: Path, expected_version: str) -> None:
    env = lifecycle_environment(layout)
    run([command("python3"), "scripts/install_menubar.py"], cwd=source, env=env)
    info = layout.menu_app / "Contents" / "Info.plist"
    with info.open("rb") as stream:
        installed = plistlib.load(stream)
    if installed.get("CFBundleShortVersionString") != expected_version:
        raise RuntimeError(
            "menu version mismatch: "
            f"expected {expected_version}, got {installed.get('CFBundleShortVersionString')}"
        )


def stage_marketplace(layout: RehearsalLayout, source: Path) -> None:
    if layout.marketplace.exists():
        shutil.rmtree(layout.marketplace)
    (layout.marketplace / ".agents" / "plugins").mkdir(parents=True)
    shutil.copy2(
        source / ".agents" / "plugins" / "marketplace.json",
        layout.marketplace / ".agents" / "plugins" / "marketplace.json",
    )
    shutil.copytree(source / "plugins", layout.marketplace / "plugins")


def install_plugin(
    layout: RehearsalLayout, source: Path, expected_version: str, first: bool
) -> None:
    stage_marketplace(layout, source)
    env = lifecycle_environment(layout)
    codex = command("codex")
    if first:
        run([codex, "plugin", "marketplace", "add", str(layout.marketplace), "--json"], env=env)
    run([codex, "plugin", "add", "boron-context@boron-context", "--json"], env=env)
    result = run(
        [codex, "plugin", "list", "--marketplace", "boron-context", "--json"], env=env
    )
    payload = json.loads(result.stdout)
    installed = payload.get("installed", [])
    if len(installed) != 1 or installed[0].get("version") != expected_version:
        raise RuntimeError(f"installed plugin version mismatch: {payload}")


def stop_daemon(layout: RehearsalLayout) -> None:
    run(
        [
            command("launchctl"),
            "bootout",
            f"gui/{os.getuid()}/{layout.daemon_label}",
        ],
        check=False,
    )
    deadline = time.monotonic() + 5
    url = f"http://127.0.0.1:{layout.daemon_port}/health"
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
        except OSError:
            return
        time.sleep(0.1)
    raise RuntimeError("daemon stayed reachable after launchd bootout")


def backup(layout: RehearsalLayout) -> dict[str, object]:
    result = run(
        [
            command("python3"),
            "scripts/macos_lifecycle.py",
            "backup",
            "--database-url",
            layout.database_url,
            "--output",
            str(layout.backup),
        ],
        cwd=layout.current,
    )
    return json.loads(result.stdout)


def restore(layout: RehearsalLayout, database_url: str) -> dict[str, object]:
    backup_receipt = json.loads(
        layout.backup.with_suffix(layout.backup.suffix + ".receipt.json").read_text()
    )
    result = run(
        [
            command("python3"),
            "scripts/macos_lifecycle.py",
            "restore",
            "--database-url",
            database_url,
            "--input",
            str(layout.backup),
            "--expected-sha256",
            str(backup_receipt["artifact"]["sha256"]),
            "--confirm-empty-target",
            "--receipt",
            str(
                layout.root
                / (
                    "restore-primary.receipt.json"
                    if database_url == layout.database_url
                    else "restore-copy.receipt.json"
                )
            ),
        ],
        cwd=layout.current,
    )
    return json.loads(result.stdout)


def assert_sentinel(layout: RehearsalLayout, database: str = "boron_lifecycle") -> None:
    value = psql(
        layout,
        database,
        "SELECT value FROM lifecycle_rehearsal_sentinel WHERE id = 1;",
    )
    if value != "preserved-across-upgrade":
        raise RuntimeError(f"lifecycle sentinel mismatch in {database}: {value!r}")


def uninstall_all(layout: RehearsalLayout) -> None:
    result = run(
        [
            command("python3"),
            "scripts/macos_lifecycle.py",
            "uninstall",
            "--home",
            str(layout.home),
            "--codex-home",
            str(layout.codex_home),
            "--daemon-label",
            layout.daemon_label,
            "--lan-label",
            layout.lan_label,
            "--menubar-label",
            layout.menu_label,
            "--remove-codex-plugin",
            "--remove-codex-marketplace",
            "--receipt",
            str(layout.uninstall_receipt),
        ],
        cwd=layout.current,
    )
    receipt = json.loads(result.stdout)
    if receipt.get("databaseAction") != "none":
        raise RuntimeError("uninstall unexpectedly changed the database")
    if layout.menu_app.exists():
        raise RuntimeError("menu application remains after uninstall")
    if any(
        (layout.home / "Library" / "LaunchAgents" / f"{label}.plist").exists()
        for label in (layout.daemon_label, layout.lan_label, layout.menu_label)
    ):
        raise RuntimeError("a launch agent remains after uninstall")
    if not layout.backup.exists():
        raise RuntimeError("uninstall removed the lifecycle backup")
    assert_sentinel(layout)


def cleanup_runtime_surfaces(layout: RehearsalLayout) -> None:
    run(
        [
            command("python3"),
            "scripts/macos_lifecycle.py",
            "uninstall",
            "--home",
            str(layout.home),
            "--codex-home",
            str(layout.codex_home),
            "--daemon-label",
            layout.daemon_label,
            "--lan-label",
            layout.lan_label,
            "--menubar-label",
            layout.menu_label,
            "--remove-codex-plugin",
            "--remove-codex-marketplace",
        ],
        cwd=layout.current,
        check=False,
    )


def assert_uninstalled_with_database_preserved(layout: RehearsalLayout) -> None:
    if layout.menu_app.exists():
        raise RuntimeError("menu application remains after clean-install uninstall")
    for label in (layout.daemon_label, layout.lan_label, layout.menu_label):
        plist = layout.home / "Library" / "LaunchAgents" / f"{label}.plist"
        if plist.exists():
            raise RuntimeError(f"launch agent remains after clean-install uninstall: {plist}")
    migration_count = int(
        psql(layout, "boron_lifecycle", "SELECT count(*) FROM boron_schema_migrations;")
    )
    if migration_count == 0:
        raise RuntimeError("uninstall did not preserve the migrated database")


def reset_primary_database(layout: RehearsalLayout) -> None:
    drop_database(layout, "boron_lifecycle")
    create_database(layout, "boron_lifecycle")


def source_version(source: Path) -> str:
    return str(json.loads((source / "package.json").read_text())["version"])


def source_plugin_version(source: Path) -> str:
    return str(
        json.loads(
            (
                source
                / "plugins"
                / "boron-context"
                / ".codex-plugin"
                / "plugin.json"
            ).read_text()
        )["version"]
    )


def source_version_at_ref(repository: Path, ref: str) -> str:
    result = run([command("git"), "show", f"{ref}:package.json"], cwd=repository)
    return str(json.loads(result.stdout)["version"])


def write_final_receipt(
    path: Path,
    *,
    status: str,
    layout: RehearsalLayout,
    previous_ref: str,
    previous_version: str | None,
    current_version: str | None,
    steps: StepLog,
    error: str | None = None,
) -> None:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "operation": "macos-lifecycle-rehearsal",
        "status": status,
        "completedAt": now(),
        "scope": "isolated macOS + Codex",
        "previousRef": previous_ref,
        "previousVersion": previous_version,
        "currentVersion": current_version,
        "isolation": {
            "temporaryHome": True,
            "temporaryCodexHome": True,
            "temporaryPostgres": True,
            "uniqueLaunchdLabels": True,
            "uniqueDaemonPort": True,
            "productionDatabaseTouched": False,
        },
        "steps": steps.steps,
    }
    if error:
        payload["error"] = error.splitlines()[0]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def rehearse(layout: RehearsalLayout, previous_ref: str, steps: StepLog) -> tuple[str, str]:
    steps.execute(
        "materialize previous release",
        lambda: materialize_ref(layout.current, previous_ref, layout.previous),
    )
    steps.execute(
        "isolate previous fixed service labels",
        lambda: apply_previous_release_isolation_shim(layout),
    )
    previous_version = source_version(layout.previous)
    current_version = source_version(layout.current)
    if previous_version == current_version:
        raise RuntimeError("previous and current versions must differ for an upgrade rehearsal")
    steps.execute("prepare previous release", lambda: prepare_source(layout.previous))
    steps.execute("prepare current release", lambda: prepare_source(layout.current))
    steps.execute("start isolated PostgreSQL", lambda: start_postgres(layout))

    steps.execute(
        "clean install current daemon",
        lambda: install_runtime(layout, layout.current, current_version),
    )
    steps.execute(
        "clean install current menu",
        lambda: install_menu(layout, layout.current, current_version),
    )
    steps.execute(
        "clean install current Codex plugin",
        lambda: install_plugin(layout, layout.current, source_plugin_version(layout.current), True),
    )
    steps.execute("uninstall current clean installation", lambda: cleanup_runtime_surfaces(layout))
    steps.execute(
        "verify clean-install uninstall preserves database",
        lambda: assert_uninstalled_with_database_preserved(layout),
    )
    steps.execute("reset clean-install database", lambda: reset_primary_database(layout))

    steps.execute(
        "install previous daemon",
        lambda: install_runtime(layout, layout.previous, previous_version),
    )
    steps.execute(
        "install previous menu",
        lambda: install_menu(layout, layout.previous, previous_version),
    )
    steps.execute(
        "install previous Codex plugin",
        lambda: install_plugin(
            layout, layout.previous, source_plugin_version(layout.previous), True
        ),
    )
    steps.execute(
        "seed pre-upgrade sentinel",
        lambda: psql(
            layout,
            "boron_lifecycle",
            "CREATE TABLE lifecycle_rehearsal_sentinel (id integer PRIMARY KEY, value text NOT NULL);"
            "INSERT INTO lifecycle_rehearsal_sentinel VALUES (1, 'preserved-across-upgrade');",
        ),
    )
    steps.execute("backup pre-upgrade database", lambda: backup(layout))

    steps.execute(
        "upgrade daemon", lambda: install_runtime(layout, layout.current, current_version)
    )
    steps.execute("upgrade menu", lambda: install_menu(layout, layout.current, current_version))
    steps.execute(
        "upgrade Codex plugin",
        lambda: install_plugin(
            layout, layout.current, source_plugin_version(layout.current), False
        ),
    )
    steps.execute("verify upgrade data continuity", lambda: assert_sentinel(layout))
    steps.execute(
        "restore backup into empty database",
        lambda: restore(layout, layout.restore_database_url),
    )
    steps.execute(
        "verify restored data",
        lambda: assert_sentinel(layout, "boron_lifecycle_restore"),
    )

    steps.execute("stop upgraded daemon", lambda: stop_daemon(layout))
    steps.execute("replace upgraded database from backup", lambda: rollback_database(layout))
    steps.execute(
        "rollback daemon",
        lambda: install_runtime(layout, layout.previous, previous_version),
    )
    steps.execute("rollback menu", lambda: install_menu(layout, layout.previous, previous_version))
    steps.execute(
        "rollback Codex plugin",
        lambda: install_plugin(
            layout, layout.previous, source_plugin_version(layout.previous), False
        ),
    )
    steps.execute("verify rollback data continuity", lambda: assert_sentinel(layout))
    steps.execute("uninstall while preserving durable data", lambda: uninstall_all(layout))
    return previous_version, current_version


def rollback_database(layout: RehearsalLayout) -> None:
    drop_database(layout, "boron_lifecycle")
    create_database(layout, "boron_lifecycle")
    restore(layout, layout.database_url)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--previous-ref", default=DEFAULT_PREVIOUS_REF)
    parser.add_argument("--workdir", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--keep-workdir", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    if sys.platform != "darwin":
        print("macOS lifecycle rehearsal requires darwin", file=sys.stderr)
        return 2
    args = build_parser().parse_args(argv)
    repository = args.repository.resolve()
    if args.workdir:
        root = args.workdir.resolve()
        root.mkdir(parents=True, exist_ok=False)
        cleanup = False
    else:
        root = Path(tempfile.mkdtemp(prefix="boron-lifecycle."))
        cleanup = not args.keep_workdir
    layout = RehearsalLayout.create(root, repository, args.previous_ref)
    receipt = args.receipt.resolve() if args.receipt else layout.receipt
    steps = StepLog()
    previous_version: str | None = source_version_at_ref(repository, args.previous_ref)
    current_version: str | None = source_version(repository)
    exit_code = 0
    try:
        previous_version, current_version = rehearse(layout, args.previous_ref, steps)
        write_final_receipt(
            receipt,
            status="passed",
            layout=layout,
            previous_ref=args.previous_ref,
            previous_version=previous_version,
            current_version=current_version,
            steps=steps,
        )
        print(receipt.read_text(), end="")
    except Exception as error:
        exit_code = 1
        write_final_receipt(
            receipt,
            status="failed",
            layout=layout,
            previous_ref=args.previous_ref,
            previous_version=previous_version,
            current_version=current_version,
            steps=steps,
            error=str(error),
        )
        print(str(error), file=sys.stderr)
        print(f"Rehearsal evidence retained at {root}", file=sys.stderr)
        cleanup = False
    finally:
        try:
            cleanup_runtime_surfaces(layout)
        except Exception:
            pass
        try:
            stop_postgres(layout)
        except Exception:
            pass
        if cleanup:
            shutil.rmtree(root, ignore_errors=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

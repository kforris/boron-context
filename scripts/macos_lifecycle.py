#!/usr/bin/env python3
"""Safe macOS lifecycle helpers for Boron Context release rehearsals.

The commands in this module deliberately separate reversible product removal from durable-data
deletion. ``uninstall`` removes launch agents, the menu application, and (when requested) the Codex
plugin registration, but it never drops PostgreSQL databases or deletes Boron state and logs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Sequence
from urllib.parse import unquote, urlparse


CommandRunner = Callable[..., subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class PostgresTarget:
    host: str
    port: int
    database: str
    username: str | None
    password: str | None

    @classmethod
    def parse(cls, value: str) -> "PostgresTarget":
        parsed = urlparse(value)
        if parsed.scheme not in {"postgres", "postgresql"}:
            raise ValueError("database URL must use postgresql:// or postgres://")
        database = unquote(parsed.path.lstrip("/"))
        if not database or "/" in database:
            raise ValueError("database URL must name exactly one database")
        return cls(
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 5432,
            database=database,
            username=unquote(parsed.username) if parsed.username else None,
            password=unquote(parsed.password) if parsed.password else None,
        )

    def command_environment(self) -> dict[str, str]:
        env = dict(os.environ)
        if self.password:
            env["PGPASSWORD"] = self.password
        return env

    def connection_arguments(self) -> list[str]:
        arguments = ["--host", self.host, "--port", str(self.port)]
        if self.username:
            arguments.extend(["--username", self.username])
        arguments.extend(["--dbname", self.database])
        return arguments

    def receipt_identity(self) -> dict[str, object]:
        return {"host": self.host, "port": self.port, "database": self.database}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_command(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise RuntimeError(f"required command is unavailable: {name}")
    return resolved


def run_command(
    arguments: Sequence[str],
    *,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(arguments),
        env=env,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def backup_database(
    database_url: str,
    output: Path,
    *,
    receipt_path: Path | None = None,
    runner: CommandRunner = run_command,
) -> dict[str, object]:
    target = PostgresTarget.parse(database_url)
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"backup destination already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    pg_dump = require_command("pg_dump")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{output.name}.", suffix=".partial", dir=output.parent, delete=False
        ) as stream:
            temporary = Path(stream.name)
        temporary.chmod(0o600)
        runner(
            [
                pg_dump,
                "--format=custom",
                "--no-owner",
                "--no-privileges",
                *target.connection_arguments(),
                "--file",
                str(temporary),
            ],
            env=target.command_environment(),
        )
        os.link(temporary, output)
        temporary.unlink()
        temporary = None
        output.chmod(0o600)
        receipt: dict[str, object] = {
            "schemaVersion": 1,
            "operation": "backup",
            "status": "completed",
            "createdAt": utc_now(),
            "database": target.receipt_identity(),
            "artifact": {
                "path": str(output),
                "bytes": output.stat().st_size,
                "sha256": sha256_file(output),
                "format": "postgresql-custom",
            },
        }
        write_receipt(receipt_path or output.with_suffix(output.suffix + ".receipt.json"), receipt)
        return receipt
    except Exception:
        if temporary:
            temporary.unlink(missing_ok=True)
        raise


def database_object_count(
    target: PostgresTarget, *, runner: CommandRunner = run_command
) -> int:
    psql = require_command("psql")
    query = """
SELECT count(*)
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
""".strip()
    result = runner(
        [
            psql,
            *target.connection_arguments(),
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--command",
            query,
        ],
        env=target.command_environment(),
    )
    return int(result.stdout.strip())


def restore_database(
    database_url: str,
    backup: Path,
    *,
    expected_sha256: str | None,
    confirm_empty_target: bool,
    receipt_path: Path | None = None,
    runner: CommandRunner = run_command,
) -> dict[str, object]:
    if not confirm_empty_target:
        raise RuntimeError("restore requires --confirm-empty-target")
    target = PostgresTarget.parse(database_url)
    backup = backup.resolve()
    if not backup.is_file():
        raise FileNotFoundError(f"backup artifact is unavailable: {backup}")
    actual_sha256 = sha256_file(backup)
    if expected_sha256 and actual_sha256.lower() != expected_sha256.lower():
        raise RuntimeError("backup SHA-256 does not match --expected-sha256")
    existing = database_object_count(target, runner=runner)
    if existing != 0:
        raise RuntimeError(
            f"restore target is not empty ({existing} user objects); restore into a new database"
        )
    pg_restore = require_command("pg_restore")
    runner(
        [
            pg_restore,
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
            *target.connection_arguments(),
            str(backup),
        ],
        env=target.command_environment(),
    )
    restored_objects = database_object_count(target, runner=runner)
    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "operation": "restore",
        "status": "completed",
        "createdAt": utc_now(),
        "database": target.receipt_identity(),
        "artifact": {"path": str(backup), "sha256": actual_sha256},
        "restoredObjectCount": restored_objects,
    }
    receipt_output = receipt_path or backup.with_suffix(backup.suffix + ".restore-receipt.json")
    write_receipt(receipt_output, receipt)
    return receipt


@dataclass(frozen=True)
class UninstallPaths:
    home: Path
    codex_home: Path
    daemon_label: str
    lan_label: str
    menubar_label: str

    def __post_init__(self) -> None:
        for label in self.labels:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", label) or ".." in label:
                raise ValueError(f"invalid launchd label: {label}")

    @property
    def launch_agents(self) -> tuple[Path, ...]:
        root = self.home / "Library" / "LaunchAgents"
        return tuple(root / f"{label}.plist" for label in self.labels)

    @property
    def labels(self) -> tuple[str, ...]:
        return (self.daemon_label, self.lan_label, self.menubar_label)

    @property
    def menu_app(self) -> Path:
        return self.home / "Applications" / "Boron Meter.app"

    @property
    def preserved_paths(self) -> tuple[Path, ...]:
        return (
            self.home / "Library" / "Application Support" / "Boron Context",
            self.home / "Library" / "Logs" / "Boron Context",
        )


def uninstall(
    paths: UninstallPaths,
    *,
    remove_codex: bool,
    remove_marketplace: bool,
    dry_run: bool,
    runner: CommandRunner = run_command,
) -> dict[str, object]:
    removed: list[str] = []
    uid = os.getuid()
    launchctl = shutil.which("launchctl")
    for label, plist in zip(paths.labels, paths.launch_agents, strict=True):
        if launchctl and not dry_run:
            runner([launchctl, "bootout", f"gui/{uid}/{label}"], check=False)
        if plist.exists():
            removed.append(str(plist))
            if not dry_run:
                plist.unlink()
    if paths.menu_app.exists():
        removed.append(str(paths.menu_app))
        if not dry_run:
            shutil.rmtree(paths.menu_app)

    codex_actions: list[str] = []
    codex = shutil.which("codex")
    codex_env = dict(os.environ)
    codex_env["CODEX_HOME"] = str(paths.codex_home)
    if remove_codex:
        if not codex:
            raise RuntimeError("codex is required to remove the installed plugin")
        listed = runner([codex, "plugin", "list", "--json"], env=codex_env)
        installed = json.loads(listed.stdout).get("installed", [])
        if any(item.get("pluginId") == "boron-context@boron-context" for item in installed):
            codex_actions.append("remove plugin boron-context@boron-context")
        if not dry_run and codex_actions:
            runner(
                [codex, "plugin", "remove", "boron-context@boron-context", "--json"],
                env=codex_env,
            )
    if remove_marketplace:
        if not codex:
            raise RuntimeError("codex is required to remove the local marketplace")
        listed = runner([codex, "plugin", "marketplace", "list", "--json"], env=codex_env)
        marketplaces = json.loads(listed.stdout).get("marketplaces", [])
        remove_registered_marketplace = any(
            item.get("name") == "boron-context" for item in marketplaces
        )
        if remove_registered_marketplace:
            codex_actions.append("remove marketplace boron-context")
        if not dry_run and remove_registered_marketplace:
            runner(
                [codex, "plugin", "marketplace", "remove", "boron-context", "--json"],
                env=codex_env,
            )

    return {
        "schemaVersion": 1,
        "operation": "uninstall",
        "status": "planned" if dry_run else "completed",
        "createdAt": utc_now(),
        "removed": removed,
        "codexActions": codex_actions,
        "preserved": [str(path) for path in paths.preserved_paths],
        "databaseAction": "none",
    }


def write_receipt(path: Path, receipt: dict[str, object]) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    path.chmod(0o600)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    backup = subparsers.add_parser("backup", help="create a non-overwriting PostgreSQL backup")
    backup.add_argument("--database-url", required=True)
    backup.add_argument("--output", type=Path, required=True)
    backup.add_argument("--receipt", type=Path)

    restore = subparsers.add_parser("restore", help="restore a verified backup into an empty DB")
    restore.add_argument("--database-url", required=True)
    restore.add_argument("--input", type=Path, required=True)
    restore.add_argument("--expected-sha256")
    restore.add_argument("--confirm-empty-target", action="store_true")
    restore.add_argument("--receipt", type=Path)

    uninstall_parser = subparsers.add_parser(
        "uninstall", help="remove runtime surfaces while preserving durable data"
    )
    uninstall_parser.add_argument("--home", type=Path, default=Path.home())
    uninstall_parser.add_argument(
        "--codex-home",
        type=Path,
        default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")),
    )
    uninstall_parser.add_argument("--daemon-label", default="dev.boroncontext.daemon")
    uninstall_parser.add_argument("--lan-label", default="dev.boroncontext.lan-mr")
    uninstall_parser.add_argument("--menubar-label", default="dev.boroncontext.menubar")
    uninstall_parser.add_argument("--remove-codex-plugin", action="store_true")
    uninstall_parser.add_argument("--remove-codex-marketplace", action="store_true")
    uninstall_parser.add_argument("--dry-run", action="store_true")
    uninstall_parser.add_argument("--receipt", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "backup":
            receipt = backup_database(args.database_url, args.output, receipt_path=args.receipt)
        elif args.command == "restore":
            receipt = restore_database(
                args.database_url,
                args.input,
                expected_sha256=args.expected_sha256,
                confirm_empty_target=args.confirm_empty_target,
                receipt_path=args.receipt,
            )
        else:
            paths = UninstallPaths(
                home=args.home.resolve(),
                codex_home=args.codex_home.resolve(),
                daemon_label=args.daemon_label,
                lan_label=args.lan_label,
                menubar_label=args.menubar_label,
            )
            receipt = uninstall(
                paths,
                remove_codex=args.remove_codex_plugin,
                remove_marketplace=args.remove_codex_marketplace,
                dry_run=args.dry_run,
            )
            if args.receipt:
                write_receipt(args.receipt, receipt)
        print(json.dumps(receipt, indent=2, sort_keys=True))
        return 0
    except (FileNotFoundError, FileExistsError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

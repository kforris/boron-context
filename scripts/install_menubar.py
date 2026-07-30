#!/usr/bin/env python3
"""Build, bundle, and keep the Boron Meter macOS menu-bar app running."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = REPO_ROOT / "apps" / "BoronMenuBar"
USER_ROOT = Path.home()
APP_BUNDLE = USER_ROOT / "Applications" / "Boron Meter.app"
CONTENTS = APP_BUNDLE / "Contents"
MACOS = CONTENTS / "MacOS"
LAUNCH_AGENT = (
    USER_ROOT / "Library" / "LaunchAgents" / "dev.boroncontext.menubar.plist"
)
LOG_ROOT = USER_ROOT / "Library" / "Logs" / "Boron Context"
DOMAIN = f"gui/{os.getuid()}"
SERVICE = f"{DOMAIN}/dev.boroncontext.menubar"


def run(
    *arguments: str, check: bool = True, quiet: bool = False
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=check,
        text=True,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.DEVNULL if quiet else None,
    )


def main() -> None:
    run("swift", "build", "-c", "release", "--package-path", str(PACKAGE_ROOT))
    binary = PACKAGE_ROOT / ".build" / "release" / "BoronMenuBar"
    if not binary.exists():
        raise SystemExit(f"Swift build succeeded but {binary} is missing")

    run("launchctl", "bootout", SERVICE, check=False, quiet=True)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = run("launchctl", "print", SERVICE, check=False, quiet=True)
        if status.returncode != 0:
            break
        time.sleep(0.1)

    MACOS.mkdir(parents=True, exist_ok=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENT.parent.mkdir(parents=True, exist_ok=True)

    installed_binary = MACOS / "BoronMenuBar"
    shutil.copy2(binary, installed_binary)
    shutil.copy2(PACKAGE_ROOT / "Info.plist", CONTENTS / "Info.plist")
    installed_binary.chmod(0o755)

    launch_definition = {
        "Label": "dev.boroncontext.menubar",
        "ProgramArguments": [str(installed_binary)],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Interactive",
        "LimitLoadToSessionType": "Aqua",
        "StandardOutPath": str(LOG_ROOT / "menubar.stdout.log"),
        "StandardErrorPath": str(LOG_ROOT / "menubar.stderr.log"),
    }
    with LAUNCH_AGENT.open("wb") as stream:
        plistlib.dump(launch_definition, stream, sort_keys=False)

    result = run(
        "launchctl", "bootstrap", DOMAIN, str(LAUNCH_AGENT), check=False, quiet=True
    )
    if result.returncode != 0:
        time.sleep(0.5)
        run("launchctl", "bootstrap", DOMAIN, str(LAUNCH_AGENT))

    print(f"Installed: {APP_BUNDLE}")
    print(f"LaunchAgent: {LAUNCH_AGENT}")
    print("Boron Meter is running in the macOS menu bar.")


if __name__ == "__main__":
    main()

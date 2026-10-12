#!/usr/bin/env python3
"""Save one private GitHub Traffic snapshot per Toronto calendar day.

Run with a directory outside the repository. GitHub Traffic requires a `gh`
identity authorized to view repository traffic; no credentials are written.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


REPOSITORY = "kforris/boron-context"
ENDPOINTS = {
    "views": f"repos/{REPOSITORY}/traffic/views",
    "clones": f"repos/{REPOSITORY}/traffic/clones",
    "referrers": f"repos/{REPOSITORY}/traffic/popular/referrers",
    "paths": f"repos/{REPOSITORY}/traffic/popular/paths",
}


def read_endpoint(endpoint: str) -> dict:
    try:
        result = subprocess.run(
            ["gh", "api", endpoint], capture_output=True, text=True, check=False
        )
    except FileNotFoundError:
        return {"status": "unavailable", "reason": "gh_missing"}
    if result.returncode != 0:
        return {"status": "unavailable", "exitCode": result.returncode}
    try:
        return {"status": "ok", "data": json.loads(result.stdout)}
    except json.JSONDecodeError:
        return {"status": "invalid_json"}


def capture(output_root: Path) -> tuple[str, Path]:
    captured_at = datetime.now(timezone.utc)
    local_date = captured_at.astimezone(ZoneInfo("America/Toronto")).date().isoformat()
    destination = output_root / local_date / "boron-context-adoption"
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / "TRAFFIC-SNAPSHOT.json"
    if target.exists():
        return "already_exists", target

    snapshot = {
        "schemaVersion": 1,
        "repository": REPOSITORY,
        "capturedAtUtc": captured_at.isoformat().replace("+00:00", "Z"),
        "localDate": local_date,
        "timezone": "America/Toronto",
        "window": "GitHub Traffic API rolling last 14 days, UTC day buckets",
        "interpretation": (
            "Clones and unique clones are GitHub traffic measurements, "
            "not verified people, installations, or product adoption."
        ),
        "sources": {
            name: {"endpoint": endpoint, **read_endpoint(endpoint)}
            for name, endpoint in ENDPOINTS.items()
        },
    }

    descriptor, temporary = tempfile.mkstemp(
        prefix=".traffic-", suffix=".json", dir=destination
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            return "already_exists", target
    finally:
        os.unlink(temporary)
    return "captured", target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-root",
        type=Path,
        required=True,
        help="Private receipt root outside this repository",
    )
    arguments = parser.parse_args()
    if arguments.output_root.resolve().is_relative_to(Path(__file__).resolve().parent.parent):
        parser.error("--output-root must be outside this repository")
    status, path = capture(arguments.output_root)
    print(json.dumps({"status": status, "path": str(path)}))


if __name__ == "__main__":
    main()

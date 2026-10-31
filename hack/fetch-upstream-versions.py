#!/usr/bin/env python3
"""Fetch every upstream release listed in hack/upstream-versions.json.

The contract checker reads files from local tags, so CI and local runs need the
registered tags before `make upstream-contract`. Existing tags are skipped.
"""

import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "hack" / "upstream-versions.json"
UPSTREAM_REPOSITORY = os.environ.get("UPSTREAM_REPOSITORY", "https://github.com/argoproj/argo-workflows.git")


def main():
    registry = json.loads(REGISTRY.read_text())
    for entry in registry["versions"]:
        tag = entry["tag"]
        existing = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}"], cwd=ROOT, capture_output=True, text=True)
        if existing.returncode == 0:
            print(f"{tag} already present")
            continue
        print(f"fetching {tag}")
        subprocess.run(
            ["git", "fetch", "--no-tags", "--depth=1", UPSTREAM_REPOSITORY, f"refs/tags/{tag}:refs/tags/{tag}"],
            cwd=ROOT,
            check=True,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

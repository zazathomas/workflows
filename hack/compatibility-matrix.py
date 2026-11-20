#!/usr/bin/env python3
"""Emit GitHub Actions matrices for registered upstream releases.

Contract checks always cover every release. Branch pushes run cluster tests on
only the oldest and newest patch per minor line; scheduled, manual, and release
runs retain the full cluster matrix. A reusable release workflow inherits the
caller's push event, so the ref type must also be checked.
"""

import argparse
import itertools
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "hack" / "upstream-versions.json"


def version_key(entry):
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", entry["tag"])
    if not match:
        raise ValueError(f"Unsupported upstream tag format: {entry['tag']}")
    return tuple(int(part) for part in match.groups())


def boundary_releases(versions):
    """Select unique numeric patch endpoints, grouped by both major and minor."""
    selected = []
    ordered = sorted(versions, key=version_key)
    for _, releases in itertools.groupby(ordered, key=lambda entry: version_key(entry)[:2]):
        releases = list(releases)
        selected.append(releases[0])
        if len(releases) > 1:
            selected.append(releases[-1])
    return selected


def matrix(versions):
    return [
        {
            "tag": entry["tag"],
            "commit": entry["commit"],
            "sha256": entry["installManifestSha256"],
            "chart": entry["helmChartVersion"],
        }
        for entry in versions
    ]


def build_outputs(registry, event_name, ref_type):
    versions = registry["versions"]
    if not versions:
        raise ValueError("The upstream release registry must not be empty")
    cluster_versions = boundary_releases(versions) if (event_name, ref_type) == ("push", "branch") else versions
    return {
        "baseline": registry["baseline"],
        "versions": matrix(versions),
        "cluster_versions": matrix(cluster_versions),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-name", required=True)
    parser.add_argument("--ref-type", required=True)
    args = parser.parse_args()
    try:
        registry = json.loads(REGISTRY.read_text())
        outputs = build_outputs(registry, args.event_name, args.ref_type)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    for name, value in outputs.items():
        encoded = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))
        print(f"{name}={encoded}")


if __name__ == "__main__":
    main()

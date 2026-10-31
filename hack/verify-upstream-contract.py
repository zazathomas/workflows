#!/usr/bin/env python3
"""Compare the fork's wire contracts with the upstream releases it claims to support.

The fork's generated API files are a snapshot of one upstream release (the
baseline). A single server image can still serve several releases when the
difference between the baseline and each target is additive: the server may
know fields a target cluster does not, but it must not lack a path, field, type,
enum value, or protobuf tag that the target cluster exposes. Differences that
remove or change something are breaking and fail this check.

Description and title text are ignored, because documentation-only edits do not
change the wire contract. Behavioral compatibility needs the cluster-backed
conformance matrix; this script only covers the schema contract.

Usage:
  verify-upstream-contract.py                 # exact match with the baseline
  verify-upstream-contract.py --all           # every registered release
  verify-upstream-contract.py --tag v4.1.3    # one release
  verify-upstream-contract.py --list          # print the registry
"""

import argparse
import json
import pathlib
import re
import subprocess
import sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "hack" / "upstream-versions.json"
SWAGGER = "api/openapi-spec/swagger.json"
PROTO = "pkg/apis/workflow/v1alpha1/generated.proto"
SET_KEYS = ("enum", "required")
DOC_KEYS = ("description", "title")
MAX_LISTED = 10


def version_key(tag):
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
    if not match:
        sys.exit(f"Unsupported upstream tag format: {tag}")
    return tuple(int(part) for part in match.groups())


def load_registry():
    registry = json.loads(REGISTRY.read_text())
    tags = [entry["tag"] for entry in registry["versions"]]
    if registry["baseline"] not in tags:
        sys.exit(f"Baseline {registry['baseline']} is not listed in {REGISTRY.name}")
    if len(set(tags)) != len(tags):
        sys.exit(f"Duplicate tags in {REGISTRY.name}")
    return registry


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def upstream(tag, path):
    try:
        return git("show", f"{tag}:{path}")
    except subprocess.CalledProcessError:
        sys.exit(f"Cannot read {path} at {tag}. Fetch the tags first: make upstream-versions")


def strip_docs(value):
    if isinstance(value, dict):
        return {key: strip_docs(item) for key, item in value.items() if key not in DOC_KEYS}
    if isinstance(value, list):
        return [strip_docs(item) for item in value]
    return value


def proto_wire(data):
    lines = (line.split("//", 1)[0].strip() for line in data.decode().splitlines())
    return [line for line in lines if line]


def short(value):
    text = json.dumps(value, sort_keys=True) if not isinstance(value, str) else value
    return text if len(text) <= 80 else text[:77] + "..."


def diff_json(fork, target, path="$"):
    """Return (added, removed, changed) where added/removed describe fork-only and target-only entries."""
    added, removed, changed = [], [], []
    if isinstance(fork, dict) and isinstance(target, dict):
        for key in sorted(set(fork) | set(target)):
            if key in DOC_KEYS:
                continue
            child = f"{path}.{key}"
            if key in SET_KEYS and isinstance(fork.get(key), list) and isinstance(target.get(key), list):
                fork_values = {short(item) for item in fork[key]}
                target_values = {short(item) for item in target[key]}
                added += [(child, value) for value in sorted(fork_values - target_values)]
                removed += [(child, value) for value in sorted(target_values - fork_values)]
            elif key not in target:
                added.append((child, short(fork[key])))
            elif key not in fork:
                removed.append((child, short(target[key])))
            else:
                sub_added, sub_removed, sub_changed = diff_json(fork[key], target[key], child)
                added += sub_added
                removed += sub_removed
                changed += sub_changed
    elif isinstance(fork, list) and isinstance(target, list):
        if len(fork) != len(target):
            changed.append((path, f"array length {len(fork)} vs {len(target)}"))
        else:
            for index, (fork_item, target_item) in enumerate(zip(fork, target)):
                sub_added, sub_removed, sub_changed = diff_json(fork_item, target_item, f"{path}[{index}]")
                added += sub_added
                removed += sub_removed
                changed += sub_changed
    elif type(fork) is not type(target):
        changed.append((path, f"{type(fork).__name__} vs {type(target).__name__}"))
    elif fork != target:
        changed.append((path, f"{short(fork)} vs {short(target)}"))
    return added, removed, changed


def check(tag, baseline):
    """Classify one release. Returns a result dict and the list of breaking findings."""
    newline = "\n"
    fork_swagger = strip_docs(json.loads((ROOT / SWAGGER).read_bytes()))
    target_swagger = strip_docs(json.loads(upstream(tag, SWAGGER)))
    added, removed, changed = diff_json(fork_swagger, target_swagger)

    fork_proto = proto_wire((ROOT / PROTO).read_bytes())
    target_proto = proto_wire(upstream(tag, PROTO))
    fork_counts, target_counts = Counter(fork_proto), Counter(target_proto)
    proto_added = sorted((fork_counts - target_counts).elements())
    proto_removed = sorted((target_counts - fork_counts).elements())

    exact = not (added or removed or changed or proto_added or proto_removed)
    newer = version_key(tag) > version_key(baseline)
    if exact:
        status = "exact"
        breaking = []
    elif newer:
        status = "breaking"
        breaking = [
            *(f"OpenAPI entry missing from the fork: {path}" for path, _ in removed),
            *(f"OpenAPI entry changed in {tag}: {path} ({detail})" for path, detail in changed),
            *(f"Protobuf declaration missing from the fork: {line}" for line in proto_removed[:MAX_LISTED]),
            *(f"OpenAPI entry not known to {tag}: {path}" for path, _ in added),
            *(f"Protobuf declaration not known to {tag}: {line}" for line in proto_added[:MAX_LISTED]),
        ]
    elif removed or changed or proto_removed:
        status = "breaking"
        breaking = [
            *(f"OpenAPI entry missing from the fork: {path}" for path, _ in removed),
            *(f"OpenAPI entry changed in {tag}: {path} ({detail})" for path, detail in changed),
            *(f"Protobuf declaration missing from the fork: {line}" for line in proto_removed[:MAX_LISTED]),
        ]
    else:
        status = "additive"
        breaking = []
    return {
        "tag": tag,
        "status": status,
        "newer_than_baseline": newer,
        "openapi_added": added,
        "openapi_removed": removed,
        "openapi_changed": changed,
        "proto_added": proto_added,
        "proto_removed": proto_removed,
        "breaking": breaking,
        "summary": newline.join(
            [
                f"{tag}: {status}"
                + (" (fork has entries this release does not)" if status == "additive" else "")
                + (f"; {len(breaking)} breaking finding(s)" if breaking else "")
            ]
        ),
    }


def verify_commit(entry):
    expected = entry["commit"]
    try:
        actual = git("rev-parse", f"{entry['tag']}^{{commit}}").decode().strip()
    except subprocess.CalledProcessError:
        sys.exit(f"Cannot resolve {entry['tag']}. Fetch the tags first: make upstream-versions")
    if actual != expected:
        sys.exit(f"{entry['tag']} points at {actual}, but {REGISTRY.name} expects {expected}")


def print_details(result, verbose):
    sections = [
        ("OpenAPI entries only in the fork", result["openapi_added"]),
        ("OpenAPI entries only in the target", result["openapi_removed"]),
        ("OpenAPI entries that differ", result["openapi_changed"]),
        ("Protobuf declarations only in the fork", [(line, "") for line in result["proto_added"]]),
        ("Protobuf declarations only in the target", [(line, "") for line in result["proto_removed"]]),
    ]
    limit = None if verbose else MAX_LISTED
    for title, items in sections:
        if not items:
            continue
        print(f"  {title}: {len(items)}")
        shown = items if limit is None else items[:limit]
        for path, detail in shown:
            print(f"    {path}{f' ({detail})' if detail else ''}")
        if limit is not None and len(items) > limit:
            print(f"    ... {len(items) - limit} more; rerun with --verbose")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tag", action="append", help="upstream release to check; repeatable")
    parser.add_argument("--all", action="store_true", help="check every release in the registry")
    parser.add_argument("--list", action="store_true", help="print the registry and exit")
    parser.add_argument("--verbose", action="store_true", help="list every difference")
    parser.add_argument("--json", action="store_true", help="print machine-readable results")
    args = parser.parse_args()

    registry = load_registry()
    baseline = registry["baseline"]
    entries = {entry["tag"]: entry for entry in registry["versions"]}

    if args.list:
        print(f"baseline: {baseline}")
        for entry in registry["versions"]:
            print(f"{entry['tag']}  {entry['commit']}  chart {entry.get('helmChartVersion', 'n/a')}")
        return 0

    if args.all:
        selected = [entry["tag"] for entry in registry["versions"]]
    elif args.tag:
        unknown = [tag for tag in args.tag if tag not in entries]
        if unknown:
            sys.exit(f"Not in {REGISTRY.name}: {', '.join(unknown)}. Add the release there first.")
        selected = args.tag
    else:
        selected = [baseline]

    results = []
    for tag in selected:
        verify_commit(entries[tag])
        result = check(tag, baseline)
        results.append(result)
        print(result["summary"])
        if tag == baseline and result["status"] != "exact":
            result["breaking"] = result["breaking"] or ["Baseline must match the checked-in generated files exactly"]
        print_details(result, args.verbose)

    if args.json:
        print(json.dumps(results, indent=2))

    failed = [result for result in results if result["breaking"]]
    for result in failed:
        print(f"\nBreaking compatibility with {result['tag']}:", file=sys.stderr)
        for finding in result["breaking"]:
            print(f"  {finding}", file=sys.stderr)
    if failed:
        print(
            "\nA newer upstream release, a required field, or a changed type cannot be served by this "
            "snapshot. Rebuild the generated API files from a compatible upstream checkout, or drop the "
            "release from hack/upstream-versions.json.",
            file=sys.stderr,
        )
        return 1

    baseline_exact = next(result for result in results if result["tag"] == baseline)
    others = [result for result in results if result["tag"] != baseline]
    print(f"\n{baseline} matches the checked-in contract exactly")
    if others:
        additive = [result["tag"] for result in others if result["status"] == "additive"]
        print(f"Additive-only contracts: {', '.join(additive) if additive else 'none'}")
    print("Schema compatibility is not behavioral compatibility; the cluster conformance matrix is still required.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

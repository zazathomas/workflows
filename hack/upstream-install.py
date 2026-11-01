#!/usr/bin/env python3
"""Print the pinned upstream install command for a release.

The manifest deployment path renders upstream's own release manifest with the
fork's server patch, so this prints the release URL together with the checksum
recorded in hack/upstream-versions.json.

Downloading a tag that is not registered yet prints the checksum to add to the
registry, which is how you register a new upstream release.

Usage:
  upstream-install.py --list
  upstream-install.py v4.1.3
  upstream-install.py v4.1.3 --download /tmp/install.yaml
  upstream-install.py v4.1.7 --download /tmp/install.yaml   # prints the checksum to register
"""

import argparse
import hashlib
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "hack" / "upstream-versions.json"


def main():
    registry = json.loads(REGISTRY.read_text())
    entries = {entry["tag"]: entry for entry in registry["versions"]}
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tag", nargs="?", help=f"one of: {', '.join(entries)}")
    parser.add_argument("--list", action="store_true", help="print registered releases and exit")
    parser.add_argument("--download", help="download the install manifest to this path after verifying its checksum")
    args = parser.parse_args()

    if args.list:
        for tag, entry in entries.items():
            mark = "*" if tag == registry["baseline"] else " "
            print(f"{mark} {tag}  chart {entry['helmChartVersion']}  {install_url(tag)}")
        return 0

    if not args.tag:
        parser.error("provide a release tag or --list")

    url = install_url(args.tag)
    entry = entries.get(args.tag)
    if entry is None and not args.download:
        sys.exit(f"{args.tag} is not registered in {REGISTRY.name}; add it there first, or pass --download to compute its checksum")

    if args.download:
        print(f"Downloading {url}", file=sys.stderr)
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
        except OSError as err:
            sys.exit(f"Cannot download {url}: {err}")
        actual = hashlib.sha256(data).hexdigest()
        if entry is not None and actual != entry["installManifestSha256"]:
            sys.exit(f"Checksum mismatch for {url}: expected {entry['installManifestSha256']}, got {actual}")
        pathlib.Path(args.download).write_bytes(data)
        if entry is None:
            print(f"{args.tag} is not registered yet; add this to {REGISTRY.name}:\n  installManifestSha256: {actual}", file=sys.stderr)
        else:
            print(f"Verified {args.tag} install manifest at {args.download}", file=sys.stderr)
        return 0

    print(f"export ARGO_UPSTREAM={args.tag}")
    print(f"export ARGO_INSTALL_SHA256={entry['installManifestSha256']}")
    print(f"export ARGO_INSTALL_URL={url}")
    return 0


def install_url(tag):
    return f"https://github.com/argoproj/argo-workflows/releases/download/{tag}/install.yaml"


if __name__ == "__main__":
    sys.exit(main())

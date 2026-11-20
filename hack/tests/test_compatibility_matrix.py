#!/usr/bin/env python3
"""Unit tests for compatibility matrix selection and GitHub Actions outputs."""

import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "hack" / "compatibility-matrix.py"
SPEC = importlib.util.spec_from_file_location("compatibility_matrix", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
compatibility_matrix = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compatibility_matrix)


def release(tag):
    return {
        "tag": tag,
        "commit": "a" * 40,
        "installManifestSha256": "b" * 64,
        "helmChartVersion": "2.0.14",
    }


class BoundaryReleasesTest(unittest.TestCase):
    def select_tags(self, tags):
        selected = compatibility_matrix.boundary_releases([release(tag) for tag in tags])
        return [entry["tag"] for entry in selected]

    def test_selects_oldest_and_newest_patch_numerically(self):
        self.assertEqual(
            self.select_tags(["v4.1.9", "v4.1.10", "v4.1.2"]),
            ["v4.1.2", "v4.1.10"],
        )

    def test_groups_by_both_major_and_minor(self):
        self.assertEqual(
            self.select_tags(["v5.1.2", "v4.2.3", "v4.1.6", "v5.1.0", "v4.1.0", "v4.2.1", "v4.2.2"]),
            ["v4.1.0", "v4.1.6", "v4.2.1", "v4.2.3", "v5.1.0", "v5.1.2"],
        )

    def test_single_release_per_minor_is_not_duplicated(self):
        self.assertEqual(self.select_tags(["v4.2.0", "v4.1.6"]), ["v4.1.6", "v4.2.0"])

    def test_orders_minor_and_major_versions_numerically(self):
        self.assertEqual(
            self.select_tags(["v10.1.0", "v4.10.0", "v4.2.0"]),
            ["v4.2.0", "v4.10.0", "v10.1.0"],
        )

    def test_rejects_invalid_release_tags(self):
        for tag in ["4.1.6", "v4.1", "v4.1.6-rc1"]:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                self.select_tags([tag])


class MatrixOutputsTest(unittest.TestCase):
    def setUp(self):
        self.registry = {
            "baseline": "v4.1.6",
            "versions": [release(tag) for tag in ["v4.1.0", "v4.1.3", "v4.1.6"]],
        }

    def test_branch_push_reduces_only_the_cluster_matrix(self):
        outputs = compatibility_matrix.build_outputs(self.registry, "push", "branch")
        self.assertEqual(outputs["baseline"], "v4.1.6")
        self.assertEqual([entry["tag"] for entry in outputs["versions"]], ["v4.1.0", "v4.1.3", "v4.1.6"])
        self.assertEqual([entry["tag"] for entry in outputs["cluster_versions"]], ["v4.1.0", "v4.1.6"])

    def test_release_tag_push_retains_every_release(self):
        # A workflow_call from release.yaml still has the caller's push event.
        outputs = compatibility_matrix.build_outputs(self.registry, "push", "tag")
        self.assertEqual(outputs["cluster_versions"], outputs["versions"])
        self.assertEqual(len(outputs["cluster_versions"]), 3)

    def test_other_events_retain_every_release(self):
        for event in ["pull_request", "schedule", "workflow_dispatch", "workflow_call"]:
            with self.subTest(event=event):
                outputs = compatibility_matrix.build_outputs(self.registry, event, "branch")
                self.assertEqual(outputs["cluster_versions"], outputs["versions"])
                self.assertEqual(len(outputs["versions"]), 3)

    def test_unknown_ref_type_does_not_reduce_release_coverage(self):
        outputs = compatibility_matrix.build_outputs(self.registry, "push", "")
        self.assertEqual(outputs["cluster_versions"], outputs["versions"])

    def test_preserves_pinned_release_metadata(self):
        outputs = compatibility_matrix.build_outputs(self.registry, "push", "branch")
        self.assertEqual(
            outputs["cluster_versions"][0],
            {"tag": "v4.1.0", "commit": "a" * 40, "sha256": "b" * 64, "chart": "2.0.14"},
        )

    def test_does_not_mutate_the_registry(self):
        original = json.dumps(self.registry)
        compatibility_matrix.build_outputs(self.registry, "push", "branch")
        self.assertEqual(json.dumps(self.registry), original)

    def test_rejects_an_empty_registry(self):
        with self.assertRaises(ValueError):
            compatibility_matrix.build_outputs({"baseline": "v4.1.6", "versions": []}, "push", "branch")

    def test_cli_emits_single_line_github_outputs(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--event-name", "push", "--ref-type", "branch"],
            check=True,
            capture_output=True,
            text=True,
        )
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 3)
        outputs = dict(line.split("=", 1) for line in lines)
        registry = json.loads(compatibility_matrix.REGISTRY.read_text())
        expected = compatibility_matrix.build_outputs(registry, "push", "branch")
        self.assertEqual(outputs["baseline"], expected["baseline"])
        for name in ["versions", "cluster_versions"]:
            self.assertEqual(json.loads(outputs[name]), expected[name])


if __name__ == "__main__":
    unittest.main()

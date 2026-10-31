#!/usr/bin/env python3
"""Unit tests for the upstream contract classifier.

Run with: python3 -m unittest discover -s hack/tests -v
"""

import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SPEC = importlib.util.spec_from_file_location("contract", ROOT / "hack" / "verify-upstream-contract.py")
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


class DiffJsonTest(unittest.TestCase):
    def test_identical_schemas_have_no_differences(self):
        schema = {"paths": {"/api/v1/workflows": {"get": {"parameters": [{"name": "namespace"}]}}}}
        self.assertEqual(contract.diff_json(schema, schema), ([], [], []))

    def test_ignores_description_and_title_text(self):
        fork = {"version": {"description": "fork text", "title": "Fork", "type": "object"}}
        target = {"version": {"description": "upstream text", "title": "Upstream", "type": "object"}}
        self.assertEqual(contract.diff_json(fork, target), ([], [], []))

    def test_reports_paths_and_fields_missing_from_either_side(self):
        fork = {"paths": {"/api/v1/workflows": {"get": {}}}, "definitions": {"A": {"properties": {"x": {"type": "string"}}}}}
        target = {"paths": {"/api/v1/workflows": {"get": {}, "post": {}}}, "definitions": {"A": {"properties": {"y": {"type": "string"}}}}}
        added, removed, changed = contract.diff_json(fork, target)
        self.assertEqual([path for path, _ in added], ["$.definitions.A.properties.x"])
        self.assertEqual([path for path, _ in removed], ["$.definitions.A.properties.y", "$.paths./api/v1/workflows.post"])
        self.assertEqual(changed, [])

    def test_treats_type_changes_and_array_length_changes_as_breaking(self):
        _, _, changed = contract.diff_json({"items": {"type": "string"}}, {"items": {"type": "object"}})
        self.assertEqual(changed, [("$.items.type", "string vs object")])
        _, _, changed = contract.diff_json({"parameters": [{}, {}]}, {"parameters": [{}]})
        self.assertEqual(changed, [("$.parameters", "array length 2 vs 1")])

    def test_compares_enum_and_required_as_sets(self):
        added, removed, changed = contract.diff_json(
            {"type": "string", "enum": ["B", "A"], "required": ["x"]},
            {"type": "string", "enum": ["A"], "required": ["x"]},
        )
        self.assertEqual([path for path, _ in added], ["$.enum"])
        self.assertEqual(removed, [])
        self.assertEqual(changed, [])


class ProtoTest(unittest.TestCase):
    def test_strips_comments_and_blank_lines(self):
        raw = b"// header\nmessage A {\n  // field comment\n  optional string name = 1; // trailing\n\n}\n"
        self.assertEqual(contract.proto_wire(raw), ["message A {", "optional string name = 1;", "}"])


class VersionTest(unittest.TestCase):
    def test_orders_releases_numerically(self):
        self.assertLess(contract.version_key("v4.1.0"), contract.version_key("v4.1.6"))
        self.assertLess(contract.version_key("v4.1.6"), contract.version_key("v4.2.0"))
        with self.assertRaises(SystemExit):
            contract.version_key("4.1.6")


class RegistryTest(unittest.TestCase):
    def test_registry_lists_the_baseline_and_unique_versions(self):
        registry = contract.load_registry()
        tags = [entry["tag"] for entry in registry["versions"]]
        self.assertIn(registry["baseline"], tags)
        self.assertEqual(len(tags), len(set(tags)))
        for entry in registry["versions"]:
            self.assertRegex(entry["installManifestSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(entry["commit"], r"^[0-9a-f]{40}$")
            self.assertRegex(entry.get("helmChartVersion", ""), r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()

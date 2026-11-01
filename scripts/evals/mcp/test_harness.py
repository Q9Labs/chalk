"""Cheap checks for failures that could silently invalidate a paid benchmark."""

import json
from pathlib import Path
import tempfile
import unittest
import uuid

from fixture import seed
from report import wilson, write_report
from run import MODEL, parse_stream
from tasks import Task, grade


class HarnessTests(unittest.TestCase):
    def test_fixture_ids_repeat_and_satisfy_webhook_v4_contract(self):
        class SeedOnlyDatabase:
            def query(self, _):
                return ""

        first = seed(SeedOnlyDatabase(), "integrity")
        second = seed(SeedOnlyDatabase(), "integrity")
        self.assertEqual(first["tenant"], second["tenant"])
        self.assertEqual(first["spaces"], second["spaces"])
        self.assertEqual(uuid.UUID(first["tenant"]).version, 4)
        self.assertNotEqual(first["key"], second["key"])

    def test_stream_accounts_all_models_and_detects_unwanted_tools(self):
        stream = [
            {"type": "system", "subtype": "init", "tools": ["Bash", "mcp__chalk__chalk_list_spaces"]},
            {"type": "assistant", "message": {"model": MODEL, "content": [
                {"type": "tool_use", "id": "one", "name": "mcp__chalk__chalk_list_spaces", "input": {}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "is_error": True}]}},
            {"type": "result", "num_turns": 2, "total_cost_usd": 0.12, "modelUsage": {
                MODEL: {"inputTokens": 10, "outputTokens": 20, "cacheReadInputTokens": 30, "cacheCreationInputTokens": 40},
                "auxiliary": {"inputTokens": 2, "outputTokens": 3}}, "result": '{"ok":true}'},
        ]
        _, metrics = parse_stream("\n".join(json.dumps(e) for e in stream))
        self.assertEqual(metrics["input_tokens"], 12)
        self.assertEqual(metrics["output_tokens"], 23)
        self.assertEqual(metrics["cache_read_input_tokens"], 30)
        self.assertEqual(metrics["cache_creation_input_tokens"], 40)
        self.assertEqual(metrics["tool_calls"], 1)
        self.assertEqual(metrics["tool_errors"], 1)
        self.assertEqual(metrics["wrong_tools"], ["Bash"])
        self.assertEqual(metrics["turns"], 2)

    def test_wrong_model_and_missing_result_are_not_valid_accounting(self):
        _, metrics = parse_stream(json.dumps({"type": "assistant", "message": {"model": "wrong-model"}}))
        self.assertTrue(metrics["wrong_model"])
        self.assertFalse(metrics["cost_accounting_complete"])

    def test_grader_rejects_claimed_write_without_state_and_boolean_count(self):
        class UnchangedDatabase:
            def query(self, _):
                return "f"

        task = Task("archive", "archive it", {"archived": True}, "select archived", "t")
        self.assertFalse(grade(task, {"archived": True}, UnchangedDatabase())[0])
        task = Task("count", "count", {"count": 1})
        self.assertFalse(grade(task, {"count": True}, UnchangedDatabase())[0])

    def test_scope_grader_requires_the_requested_operation_and_rejection(self):
        task = Task("missing-scope", "attempt rename", {"changed": False, "missing_scope": "tenants:write"})
        unrelated = {"server_outcomes": {"chalk_inspect_space:auth.forbidden": 1}}
        self.assertFalse(grade(task, task.expected, None, unrelated)[0])
        requested = {"server_outcomes": {"chalk_update_tenant:auth.forbidden": 1}}
        self.assertTrue(grade(task, task.expected, None, requested)[0])

    def test_comparison_rejects_partial_or_different_task_sets(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "tools.json", Path(directory) / "code.json"
            first.write_text(json.dumps({"config": {"arm": "tools"}, "complete": False}))
            with self.assertRaisesRegex(ValueError, "incomplete"):
                write_report([first], Path(directory) / "report.md")
            config = {key: "same" for key in ("model", "effort", "k", "concurrency", "timeout", "budget", "suite_sha256", "fixture_sha256", "system_sha256", "revision", "server_revision", "cli_version")}
            first.write_text(json.dumps({"config": {**config, "arm": "tools", "tasks": ["a"]}, "complete": True}))
            second.write_text(json.dumps({"config": {**config, "arm": "code", "tasks": ["b"]}, "complete": True}))
            with self.assertRaisesRegex(ValueError, "different"):
                write_report([first, second], Path(directory) / "report.md")

    def test_confidence_interval_does_not_claim_certainty_after_one_success(self):
        lower, upper = wilson(1, 1)
        self.assertAlmostEqual(lower, 0.20654931437723745)
        self.assertAlmostEqual(upper, 1.0)


if __name__ == "__main__":
    unittest.main()

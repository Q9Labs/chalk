import copy
import unittest
from dispatcher_binding import binding_target, check_binding, check_binding_plan


class DispatcherBindingTests(unittest.TestCase):
    def test_uses_api_component_identity_not_manifest_identity(self):
        manifest = {"release_id": "managed-new", "component_releases": {"api": {"release_id": "managed-api-retained"}}}
        self.assertEqual(binding_target(manifest), "managed-api-retained")

    def test_rejects_retired_unapproved_or_unhealthy_binding(self):
        function = {"State": "Active", "LastUpdateStatus": "Successful", "CodeSha256": "digest",
                    "Environment": {"Variables": {"CHALK_RELEASE_ID": "approved-release"}}}
        check_binding(function, "approved-release", "digest")
        for release in ("retired-release", "unapproved-release"):
            with self.assertRaises(ValueError):
                check_binding(function, release, "digest")
        with self.assertRaises(ValueError):
            check_binding(function, "approved-release", "other-digest")

    def test_plan_rejects_auth_or_scheduler_changes(self):
        before = {"environment": [{"variables": {"CHALK_RELEASE_ID": "old-release", "AUTH": "secret-reference"}}],
                  "s3_key": "old.zip", "s3_object_version": "old", "description": "old",
                  "tags": {"chalk_release_id": "old-release"}, "tags_all": {"chalk_release_id": "old-release"}}
        after = copy.deepcopy(before)
        after.update(s3_key="new.zip", s3_object_version="new", description="Track-aware transcription dispatcher (new-release)")
        after["environment"][0]["variables"]["CHALK_RELEASE_ID"] = "new-release"
        for key in ("tags", "tags_all"):
            after[key]["chalk_release_id"] = "new-release"
        change = {"address": "module.dispatcher.aws_lambda_function.dispatcher",
                  "change": {"actions": ["update"], "before": before, "after": after, "after_unknown": {}}}
        plan = {"resource_changes": [change]}
        check_binding_plan(plan, "new-release", "new.zip", "new")
        after["environment"][0]["variables"]["AUTH"] = "other-secret"
        with self.assertRaises(ValueError):
            check_binding_plan(plan, "new-release", "new.zip", "new")
        change["address"] = "module.dispatcher.aws_scheduler_schedule.reconcile"
        with self.assertRaises(ValueError):
            check_binding_plan(plan, "new-release", "new.zip", "new")

class BindingDeploymentTests(unittest.TestCase):
    def test_retained_api_dry_run_explicitly_needs_no_copy(self):
        from unittest.mock import Mock, patch
        from dispatcher_binding import bind
        provider = Mock()
        provider.aws.return_value = {"State": "Active", "LastUpdateStatus": "Successful", "CodeSha256": "code-hash",
                                     "Environment": {"Variables": {"CHALK_RELEASE_ID": "retained-api"}}}
        root = {"module": {"dispatcher": {"release_id": "retained-api", "artifact_sha256": "digest", "artifact_sha256_base64": "code-hash"}}}
        with patch("dispatcher_binding.dispatcher_root", return_value=root):
            proof = bind(provider, {"function_name": "dispatcher"}, {"component_releases": {"api": {"release_id": "retained-api"}}}, True)
        self.assertEqual(proof["action"], "already-bound")
        self.assertEqual(proof["artifact_action"], "retain current versioned ZIP")
        provider.command.assert_not_called()

    def test_e30_plan_rejects_deferred_policies_but_allows_targeted_binding(self):
        import json
        from pathlib import Path
        plan = json.loads(Path(__file__).with_name("fixtures").joinpath("dispatcher-rebind-plan.json").read_text())
        with self.assertRaisesRegex(ValueError, "allowlist"):
            check_binding_plan(plan, "next-api-release", "next-api-release/qualified.zip", "next-version", "redacted-16")
        for suffix in ("aws_cloudwatch_log_group.dispatcher", "aws_lambda_function.dispatcher"):
            resource = next(item for item in plan["resource_changes"] if item["address"].endswith(suffix))
            check_binding_plan({"resource_changes": [resource]}, "next-api-release", "next-api-release/qualified.zip", "next-version", "redacted-16")
        function = next(item for item in plan["resource_changes"] if item["address"].endswith("aws_lambda_function.dispatcher"))
        for field in ("code_sha256", "source_code_size"):
            function["change"]["after_unknown"][field] = True
        check_binding_plan({"resource_changes": [function]}, "next-api-release", "next-api-release/qualified.zip", "next-version", "redacted-16")

    def test_rebind_copies_pinned_bytes_and_verifies_after_apply(self):
        import base64
        import json
        from pathlib import Path
        from unittest.mock import Mock, patch
        from dispatcher_binding import bind
        from release_core import digest
        archive = b"qualified-dispatcher-zip"
        code_hash = base64.b64encode(bytes.fromhex(digest(archive))).decode()
        root = {"module": {"dispatcher": {"release_id": "old-release", "function_name": "dispatcher",
                "artifact_sha256": digest(archive), "artifact_sha256_base64": code_hash,
                "artifact_s3_bucket": "test-bucket", "artifact_s3_key": "old-release.zip", "artifact_s3_object_version": "pinned-version"}}}
        provider = Mock()
        events = []

        def aws(service, operation, *args):
            events.append(operation)
            if operation == "get-function-configuration":
                return {"State": "Active", "LastUpdateStatus": "Successful", "CodeSha256": code_hash,
                        "Environment": {"Variables": {"CHALK_RELEASE_ID": "old-release"}}}
            if operation == "get-object":
                self.assertIn("pinned-version", args)
                Path(args[-1]).write_bytes(archive)
                return {}
            if operation == "copy-object":
                self.assertIn("test-bucket/old-release.zip?versionId=pinned-version", args)
                return {"VersionId": "new-version"}
            self.fail(operation)

        def command(args, **kwargs):
            events.append(args[2])
            return json.dumps({"resource_changes": []}) if args[2] == "show" else ""

        provider.aws.side_effect = aws
        provider.command.side_effect = command
        with patch("dispatcher_binding.dispatcher_root", return_value=root), patch("dispatcher_binding.verify_dispatcher") as verify:
            verify.side_effect = lambda *args: events.append("verify") or {"verified": True}
            result = bind(provider, {"function_name": "dispatcher"}, {"component_releases": {"api": {"release_id": "new-release"}}}, False)
        self.assertTrue(result["verified"])
        self.assertLess(events.index("copy-object"), events.index("apply"))
        self.assertLess(events.index("apply"), events.index("verify"))
        self.assertEqual(root["module"]["dispatcher"]["artifact_s3_object_version"], "new-version")

    def test_loaded_process_rejects_binding_mismatch(self):
        import importlib.util
        import json
        from pathlib import Path
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location("loaded", Path(__file__).with_name("verify-loaded-runtime.py"))
        loaded = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loaded)
        manifest = {"release_id": "managed-release", "images": {"api": "api-image"},
                    "component_releases": {"api": {"release_id": "current-api"}}}
        values = [json.dumps({"Parameter": {"Value": ""}}),
                  json.dumps([{"State": {"Running": True, "Pid": 42}, "Config": {"Image": "api-image"}}])]
        with patch.object(Path, "read_text", return_value=json.dumps(manifest)), patch.object(Path, "read_bytes", return_value=b"CHALK_API_VERSION=current-api\0"), \
                patch("subprocess.run"), patch("subprocess.check_output", side_effect=values):
            with self.assertRaisesRegex(RuntimeError, "dispatcher/API loaded release binding mismatch"):
                loaded.verify({"user_id": 1000, "region": "test", "parameter_prefix": "/test", "dispatcher_release_id": "retired-api"})


if __name__ == "__main__":
    unittest.main()

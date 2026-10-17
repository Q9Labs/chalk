"""Offline reconciliation regression: the provisioning lane owns the group."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from release_core import rebuild_dispatcher
from test_release import dispatcher_state_fixture


class DispatcherReconstructionTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("tofu"), "OpenTofu is required for the offline plan")
    def test_nightly_reconstruction_does_not_manage_external_scheduler_group(self):
        repository = Path(__file__).resolve().parents[2]
        module = repository / "infrastructure/opentofu/modules/aws-transcription-dispatcher"
        caller = (repository / "infrastructure/nightly/transcription/main.tf").read_text()
        self.assertNotIn('resource "aws_scheduler_schedule_group"', caller)
        self.assertRegex(caller, r'scheduler_group_name\s*=\s*"chalk-nightly"')
        state = dispatcher_state_fixture()
        # A provisioned nightly's dispatcher state contains the schedule, not
        # the group: provisioning has its own state and remains the sole owner.
        for resource in state["resources"]:
            resource["module"] = "module.dispatcher"
            attrs = resource["instances"][0]["attributes"]
            if resource["type"] == "aws_scheduler_schedule":
                attrs.update(name="chalk-nightly-transcription-reconcile", group_name="chalk-nightly")
            if resource["type"] == "aws_lambda_permission":
                attrs.update(principal="000000000000", source_arn="arn:aws:execute-api:ap-southeast-1:000000000000:test/*")
            if resource["type"] == "aws_iam_role_policy":
                attrs["policy"] = json.dumps({"Statement": [{"Resource": ["arn:aws:kms:ap-southeast-1:000000000000:key/test"]}]})
            if resource["type"] == "aws_lambda_function":
                attrs.update(function_name="chalk-nightly-transcription-dispatcher", timeout=600,
                             reserved_concurrent_executions=3, s3_key="test-release/dispatcher.zip")
                attrs["environment"][0]["variables"].update({
                    "CHALK_ENVIRONMENT": "nightly", "CHALK_RELEASE_ID": "test-release",
                    "CHALK_RELEASE_MANIFEST_DIGEST": "sha256:" + "0" * 64,
                    "CHALK_CONFIG_DIGEST": "sha256:" + "0" * 64,
                    "CONTROL_API_BASE_URL": "https://nightly-api.chalkmeet.com",
                    "CONTROL_API_AUDIENCE": "chalk-nightly-control-api",
                    "CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN": "arn:aws:ssm:ap-southeast-1:000000000000:parameter/chalk/nightly/auth",
                    "TRANSCRIPTION_PRIVACY_GATE_ACCEPTED": "true",
                    "DEEPINFRA_TOKEN_PARAMETER_ARN": "arn:aws:ssm:ap-southeast-1:000000000000:parameter/chalk/nightly/deepinfra",
                    "DEEPINFRA_CORPUS_DIGEST": "0" * 64,
                })
        root = rebuild_dispatcher(state, module, {"state_bucket": "test-state", "state_key": "test.tfstate"},
                                  "ap-southeast-1", "test-profile")
        self.assertEqual(root["module"]["dispatcher"]["scheduler_group_name"], "chalk-nightly")
        # Use local test state and a mock provider only; never contact AWS/S3.
        del root["terraform"]["backend"]
        del root["provider"]
        del root["output"]
        mock_provider = (module / "tests/networking.tftest.hcl").read_text().split("\nvariables {", 1)[0]
        with tempfile.TemporaryDirectory(prefix="chalk-dispatcher-reconstruction-") as directory:
            directory = Path(directory)
            shutil.copyfile(module / ".terraform.lock.hcl", directory / ".terraform.lock.hcl")
            (directory / "main.tf.json").write_text(json.dumps(root))
            (directory / "tests").mkdir()
            (directory / "tests/reconstruction.tftest.hcl").write_text(mock_provider + '''
run "provision_fixture" {
  command = apply
}
run "reconstructed_plan" {
  command = plan
}
''')
            self.run_tofu(directory, "init", "-backend=false", "-input=false")
            output = self.run_tofu(directory, "test", "-json", "-verbose")
            plans = [json.loads(line)["test_plan"] for line in output.splitlines()
                     if json.loads(line).get("type") == "test_plan"]
            self.assertTrue(plans, output)
            changes = plans[-1]["resource_changes"]
            self.assertTrue(changes)
            self.assertFalse(any(change["type"] == "aws_scheduler_schedule_group" for change in changes))
            self.assertTrue(all(change["change"]["actions"] == ["no-op"] for change in changes), output)
            schedule = next(change for change in changes if change["type"] == "aws_scheduler_schedule")
            self.assertEqual(schedule["change"]["after"]["group_name"], "chalk-nightly")

    def run_tofu(self, directory, *arguments):
        result = subprocess.run(["tofu", f"-chdir={directory}", *arguments], capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

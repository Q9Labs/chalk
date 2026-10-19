import base64
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from release_core import (PIN_KEYS, check_fresh, check_image, check_qualification,
                          digest, env_values, rebuild_dispatcher, replace_pins, scheduler_changes, validate_config)
from release_io import Provider


def dispatcher_state_fixture():
    function = {"environment": [{"variables": {"CHALK_ENVIRONMENT": "production", "DEEPINFRA_ENABLED": "true", "TRANSCRIPTION_MAX_BATCH": "7"}}],
                "function_name": "test-function", "s3_bucket": "test-artifacts", "s3_key": "test.zip", "s3_object_version": "test-version",
                "source_code_hash": base64.b64encode(b"a" * 32).decode(), "handler": "index.handler", "timeout": 60,
                "memory_size": 512, "ephemeral_storage": [{"size": 512}], "reserved_concurrent_executions": 2}
    attributes = {
        "aws_lambda_function.dispatcher": function,
        "aws_scheduler_schedule.reconcile": {"name": "test-scheduler", "group_name": "default", "state": "ENABLED",
                                              "target": [{"input": "{}", "retry_policy": [{"maximum_event_age_in_seconds": 60, "maximum_retry_attempts": 1}]}]},
        "aws_lambda_function_event_invoke_config.dispatcher": {"maximum_event_age_in_seconds": 60, "maximum_retry_attempts": 1},
        "aws_cloudwatch_log_group.dispatcher": {"retention_in_days": 7, "kms_key_id": ""},
        "aws_sqs_queue.async_failure": {"kms_master_key_id": ""},
        "aws_cloudwatch_metric_alarm.errors": {"alarm_actions": []},
        "aws_iam_role_policy.dispatcher": {"policy": json.dumps({"Statement": [{"Resource": ["arn:test:kms:key", "arn:test:ssm:path"]}]})},
        "aws_lambda_permission.control_api": {"principal": "test-principal", "source_arn": "arn:test:source"},
    }
    state = {"resources": [{"type": key.split('.')[0], "name": key.split('.')[1], "instances": [{"attributes": value}]}
                           for key, value in attributes.items()], "outputs": {"function_name": {"sensitive": False}}}
    return state


class ReleaseContracts(unittest.TestCase):
    def test_provider_uses_the_fleet_token_only_in_child_environment(self):
        provider = Provider('test-region', None)
        provider.context = 'private-context'
        provider.do_token = 'fixture-fleet-token'
        with patch.dict(os.environ, DIGITALOCEAN_ACCESS_TOKEN='fixture-builder-token'), patch('subprocess.run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout='[]', stderr='')
            self.assertEqual(provider.do('compute', 'image', 'get', '123'), [])
            arguments, options = run.call_args
            self.assertNotIn('--context', arguments[0])
            self.assertNotIn('fixture-fleet-token', arguments[0])
            self.assertEqual(options['env']['DIGITALOCEAN_ACCESS_TOKEN'], 'fixture-fleet-token')
            self.assertEqual(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], 'fixture-builder-token')

    def test_nightly_release_configuration_is_environment_scoped(self):
        config = {
            "schema_version": 1, "do_context": "chalk-nightly",
            "bootstrap_ca_parameter": "/chalk/nightly/managed-episode/recorder/issuer-server-ca",
            "bootstrap_server_name": "nightly-recording-control.chalkmeet.com",
            "builder": {"region": "blr1", "size": "c-8", "image": "test", "ttl_seconds": 1200, "ssh_cidr": "192.0.2.1/32"},
            "worker": {"region": "blr1", "size": "c-2", "disk_gb": 25},
            "runtime": {"instance_id": "i-0123456789abcdef0", "parameter_prefix": "/chalk/nightly/managed-episode", "document_name": "chalk-nightly-managed-episode-release", "log_group": "/chalk/nightly/managed-episode", "user_id": 1000},
            "dispatcher": {"state_bucket": "chalk-nightly-state-000000000000", "state_key": "transcription/terraform.tfstate", "function_name": "chalk-nightly-transcription-dispatcher", "scheduler_name": "chalk-nightly-transcription-reconcile", "scheduler_group": "chalk-nightly"},
        }
        self.assertEqual(validate_config(config, "nightly"), config)
        config["do_context"] = "existing-builder-context"
        self.assertEqual(validate_config(config, "nightly"), config)
        config["do_context"] = " "
        with self.assertRaisesRegex(ValueError, "nightly DigitalOcean context"):
            validate_config(config, "nightly")
        config["do_context"] = "chalk-nightly"
        with self.assertRaisesRegex(ValueError, "outside selected environment"):
            validate_config(config, "production")
        config["runtime"]["parameter_prefix"] = "/chalk/production/managed-episode"
        with self.assertRaisesRegex(ValueError, "outside selected environment"):
            validate_config(config, "nightly")


    def test_dispatcher_root_preserves_typed_live_inputs_and_backend(self):
        state = dispatcher_state_fixture()
        module = Path(__file__).resolve().parents[2] / "infrastructure/opentofu/modules/aws-transcription-dispatcher"
        root = rebuild_dispatcher(state, module, {"state_bucket": "test-state", "state_key": "test.tfstate"}, "test-region", "test-profile")
        inputs = root["module"]["dispatcher"]
        self.assertIs(inputs["deepinfra_enabled"], True)
        self.assertEqual(inputs["max_batch"], 7)
        self.assertEqual(inputs["ssm_kms_key_arns"], ["arn:test:kms:key"])
        self.assertEqual(root["terraform"]["backend"]["s3"]["bucket"], "test-state")
        self.assertEqual(inputs["artifact_s3_object_version"], "test-version")
        self.assertEqual(inputs["control_api_invoker_principal"], "test-principal")
        self.assertEqual(inputs["control_api_invoke_source_arn"], "arn:test:source")

    def test_pins_preserve_comments_secrets_newlines_and_unrelated_values(self):
        text = "# retained\r\nSECRET=a=b\r\nCHALK_RECORDER_FLEET_IMAGE_ID=123\r\nCHALK_RECORDER_FLEET_RELEASE_ID=old\nCHALK_RECORDER_FLEET_IMAGE_DIGEST=old"
        updates = {"CHALK_RECORDER_FLEET_IMAGE_ID": "456", "CHALK_RECORDER_FLEET_RELEASE_ID": "new"}
        updated = replace_pins(text, updates)
        self.assertEqual(updated, text.replace("IMAGE_ID=123", "IMAGE_ID=456").replace("RELEASE_ID=old", "RELEASE_ID=new"))
        self.assertEqual(env_values(updated)["SECRET"], "a=b")

    def test_pin_scope_is_closed(self):
        with self.assertRaises(ValueError):
            replace_pins("SECRET=x\n", {"SECRET": "changed"})
        with self.assertRaises(ValueError):
            replace_pins("SECRET=x\n", {"CHALK_RECORDER_FLEET_IMAGE_ID": "456"})
        with self.assertRaises(ValueError):
            env_values("SECRET=x\nSECRET=y\n")

    def test_stale_ssm_version_or_hash_stops_publication(self):
        receipt = {"before_version": 3, "before_sha256": digest("old")}
        check_fresh({"Version": 3, "Value": "old"}, receipt)
        for parameter in ({"Version": 4, "Value": "old"}, {"Version": 3, "Value": "new"}):
            with self.assertRaises(ValueError):
                check_fresh(parameter, receipt)

    def test_fleet_disk_region_and_availability_are_required(self):
        worker = {"disk_gb": 25, "region": "test1"}
        image = {"min_disk_size": 25, "status": "available", "regions": ["test1"]}
        check_image(image, worker)
        for changes in ({"min_disk_size": 26}, {"status": "creating"}, {"regions": ["other1"]}):
            with self.assertRaises(ValueError):
                check_image({**image, **changes}, worker)

    def test_qualification_requires_signed_boot_and_exact_identity(self):
        state = {"role": "render", "source_commit": "a" * 40, "release_id": "release-test", "image_id": "123", "image_digest": "sha256:" + "b" * 64,
                 "region": "test1", "size": "test-size"}
        receipt = {**state, "result": "PASS", "fleet_equivalent_signed_boot": True}
        check_qualification(receipt, state)
        for changes in ({"fleet_equivalent_signed_boot": False}, {"image_id": "456"}, {"source_commit": "c" * 40}, {"result": "FAIL"},
                        {"region": "other1"}, {"size": "larger-size"}):
            with self.assertRaises(ValueError):
                check_qualification({**receipt, **changes}, state)

    def test_scheduler_plan_only_changes_state(self):
        item = {"address": "module.dispatcher.aws_scheduler_schedule.reconcile", "change": {
            "actions": ["update"], "before": {"state": "ENABLED", "target": "same"}, "after": {"state": "DISABLED", "target": "same"}}}
        scheduler_changes({"resource_changes": [item]}, "DISABLED")
        item["change"]["after"]["target"] = "changed"
        with self.assertRaises(ValueError):
            scheduler_changes({"resource_changes": [item]}, "DISABLED")

    def test_dry_run_refuses_every_mutation_before_spawning(self):
        provider = Provider("test-region", "test-profile", dry_run=True)
        provider.context = "test-context"
        with patch("subprocess.run") as run:
            for service, operation in (("ssm", "put-parameter"), ("ssm", "send-command"), ("scheduler", "update-schedule")):
                with self.assertRaises(ValueError):
                    provider.aws(service, operation)
            for args in (("compute", "droplet", "create"), ("compute", "droplet", "delete"), ("compute", "droplet-action", "snapshot")):
                with self.assertRaises(ValueError):
                    provider.do(*args)
            with self.assertRaises(ValueError):
                provider.command(["ssh", "host", "true"])
            run.assert_not_called()

    def test_dry_run_allows_provider_reads(self):
        provider = Provider("test-region", "test-profile", dry_run=True)
        provider.context = "test-context"
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, '{}', '')):
            self.assertEqual(provider.aws("ssm", "get-parameter", "--name", "/test"), {})
            self.assertEqual(provider.do("compute", "image", "get", "123"), {})


if __name__ == "__main__":
    unittest.main()

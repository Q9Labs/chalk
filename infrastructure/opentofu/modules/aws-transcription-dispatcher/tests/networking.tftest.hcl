mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/test-dispatcher"
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:test-dispatcher"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:123456789012:test-dispatcher"
      id  = "https://sqs.us-east-1.amazonaws.com/123456789012/test-dispatcher"
    }
  }
  mock_resource "aws_scheduler_schedule" {
    defaults = {
      arn = "arn:aws:scheduler:us-east-1:123456789012:schedule/default/test-dispatcher"
    }
  }
}

variables {
  function_name                   = "chalk-dispatcher-networking-test"
  environment_name                = "test"
  release_id                      = "networking-proof-20260917"
  release_manifest_digest         = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  config_digest                   = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  artifact_s3_bucket              = "chalk-dispatcher-test-artifacts"
  artifact_s3_key                 = "networking-proof-20260917/dispatcher.zip"
  artifact_s3_object_version      = "immutable-test-version"
  artifact_sha256                 = "0000000000000000000000000000000000000000000000000000000000000000"
  artifact_sha256_base64          = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  control_api_url                 = "https://control.example.com"
  control_api_audience            = "chalk-transcription-test"
  privacy_gate_accepted           = true
  deepinfra_enabled               = true
  scheduler_state                 = "DISABLED"
  deepinfra_corpus_digest         = "0000000000000000000000000000000000000000000000000000000000000000"
  deepinfra_token_parameter_arn   = "arn:aws:ssm:us-east-1:123456789012:parameter/test/deepinfra"
  api_workload_auth_parameter_arn = "arn:aws:ssm:us-east-1:123456789012:parameter/test/control"
  cloudflare_token_parameter_arn  = "arn:aws:ssm:us-east-1:123456789012:parameter/test/disabled-cloudflare"
}

run "deepinfra_without_customer_vpc" {
  command = plan

  assert {
    condition     = length(aws_lambda_function.dispatcher.vpc_config) == 0
    error_message = "The dispatcher must retain default Lambda internet access without a customer VPC."
  }

  assert {
    condition     = aws_lambda_function.dispatcher.environment[0].variables.DEEPINFRA_ENABLED == "true" && aws_lambda_function.dispatcher.environment[0].variables.CLOUDFLARE_AI_ENABLED == "false"
    error_message = "Removing the VPC must not enable Cloudflare fallback or disable direct DeepInfra."
  }

  assert {
    condition     = contains(local.ssm_parameter_arns, var.deepinfra_token_parameter_arn) && !contains(local.ssm_parameter_arns, var.cloudflare_token_parameter_arn)
    error_message = "The disabled provider credential must remain outside the SSM IAM scope."
  }

  assert {
    condition     = contains(output.required_egress_destinations, "api.deepinfra.com") && !contains(output.required_egress_destinations, "api.cloudflare.com")
    error_message = "The outbound inventory must reflect only enabled providers."
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.dispatcher.environment[0].variables), "CLOUDFLARE_AI_TOKEN_PARAMETER_ARN") && !contains(keys(aws_lambda_function.dispatcher.environment[0].variables), "DEEPINFRA_EXECUTION_IDENTITY_PIN") && !contains(keys(aws_lambda_function.dispatcher.environment[0].variables), "DEEPINFRA_MODEL_VERSION_PIN")
    error_message = "Disabled-provider credentials and unobserved optional DeepInfra pins must not be placed in the Lambda environment."
  }

  assert {
    condition     = lookup(aws_cloudwatch_metric_alarm.scheduler_target_errors.dimensions, "ScheduleGroup", "") == aws_scheduler_schedule.reconcile.group_name && !contains(keys(aws_cloudwatch_metric_alarm.scheduler_target_errors.dimensions), "ScheduleName")
    error_message = "EventBridge Scheduler target errors must use the documented ScheduleGroup metric dimension."
  }
}

run "reject_no_provider" {
  command = plan
  variables {
    deepinfra_enabled = false
  }
  expect_failures = [aws_lambda_function.dispatcher]
}

run "reject_missing_deepinfra_credential" {
  command = plan
  variables {
    deepinfra_token_parameter_arn = ""
  }
  expect_failures = [aws_lambda_function.dispatcher]
}

run "accept_binary_archive_digest" {
  command = plan
  variables {
    artifact_sha256        = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    artifact_sha256_base64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
  }
}

run "reject_noncanonical_archive_digest" {
  command = plan
  variables {
    artifact_sha256_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB="
  }
  expect_failures = [var.artifact_sha256_base64]
}

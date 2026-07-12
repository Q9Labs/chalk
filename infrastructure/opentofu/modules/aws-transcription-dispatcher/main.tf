locals {
  ssm_parameter_arns = [
    var.deepinfra_token_parameter_arn,
    var.cloudflare_token_parameter_arn,
    var.api_workload_auth_parameter_arn,
  ]

  base_environment = {
    CHALK_ENVIRONMENT                       = var.environment_name
    CHALK_RELEASE_ID                        = var.release_id
    CHALK_RELEASE_MANIFEST_DIGEST           = var.release_manifest_digest
    CHALK_CONFIG_DIGEST                     = var.config_digest
    CONTROL_API_BASE_URL                    = var.control_api_url
    CONTROL_API_AUDIENCE                    = var.control_api_audience
    TRANSCRIPTION_MAX_BATCH                 = tostring(var.max_batch)
    TRANSCRIPTION_CONCURRENCY               = tostring(var.reserved_concurrency)
    TRANSCRIPTION_TIMEOUT_RESERVE_MS        = tostring(var.completion_reserve_seconds * 1000)
    TRANSCRIPTION_PRIVACY_GATE_ACCEPTED     = tostring(var.privacy_gate_accepted)
    DEEPINFRA_ENABLED                       = tostring(var.deepinfra_enabled)
    DEEPINFRA_EXECUTION_IDENTITY_PIN        = var.deepinfra_execution_identity_pin
    DEEPINFRA_MODEL_VERSION_PIN             = var.deepinfra_model_version_pin
    CLOUDFLARE_ACCOUNT_ID                   = var.cloudflare_account_id
    CLOUDFLARE_MODEL_SLUG                   = var.cloudflare_model_slug
    CLOUDFLARE_ADAPTER_CONTRACT_VERSION     = var.cloudflare_adapter_contract_version
    CLOUDFLARE_CORPUS_DIGEST                = var.cloudflare_corpus_digest
    TRANSCRIPTION_PROVIDER_TIMEOUT_MS       = tostring(var.provider_timeout_ms)
    TRANSCRIPTION_MAX_AUDIO_BYTES           = tostring(var.max_audio_bytes)
    TRANSCRIPTION_MAX_AUDIO_SECONDS         = tostring(var.max_audio_seconds)
    TRANSCRIPTION_MAX_RESPONSE_BYTES        = tostring(var.max_response_bytes)
    TRANSCRIPTION_MAX_TEXT_CHARS            = tostring(var.max_text_chars)
    TRANSCRIPTION_MAX_SEGMENTS              = tostring(var.max_segments)
    TRANSCRIPTION_MAX_WORDS                 = tostring(var.max_words)
    TRANSCRIPTION_MAX_RETRIES               = tostring(var.provider_max_retries)
    TRANSCRIPTION_RETRY_BASE_DELAY_MS       = tostring(var.retry_base_delay_ms)
    TRANSCRIPTION_RETRY_MAX_DELAY_MS        = tostring(var.retry_max_delay_ms)
    TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD = tostring(var.circuit_failure_threshold)
    TRANSCRIPTION_CIRCUIT_COOLDOWN_MS       = tostring(var.circuit_cooldown_ms)
    CHALK_TRANSCRIPTION_HANDLER             = var.handler
    CHALK_TRANSCRIPTION_WORK_BUDGET         = tostring(var.work_budget_seconds)
    CHALK_COMPLETION_RESERVE_SECONDS        = tostring(var.completion_reserve_seconds)
    CHALK_VPC_EGRESS_MODE                   = var.vpc_egress_mode
    DEEPINFRA_TOKEN_PARAMETER_ARN           = var.deepinfra_token_parameter_arn
    CLOUDFLARE_AI_TOKEN_PARAMETER_ARN       = var.cloudflare_token_parameter_arn
    CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN = var.api_workload_auth_parameter_arn
    CHALK_EGRESS_ALLOWLIST                  = join(",", sort(tolist(var.vpc_egress_allowlist)))
  }

}

resource "aws_cloudwatch_log_group" "dispatcher" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = {
    chalk_environment = var.environment_name
    chalk_release_id  = var.release_id
    chalk_component   = "transcription-dispatcher"
  }
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    sid     = "LambdaAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dispatcher" {
  name               = "${var.function_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    chalk_environment = var.environment_name
    chalk_component   = "transcription-dispatcher"
  }
}

data "aws_iam_policy_document" "dispatcher_permissions" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.dispatcher.arn}:*"]
  }

  statement {
    sid    = "ReadOnlyTranscriptionAndApiSecrets"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = local.ssm_parameter_arns
  }

  statement {
    sid       = "WriteOnlyAsyncFailureDestination"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.async_failure.arn]
  }

  dynamic "statement" {
    for_each = length(var.ssm_kms_key_arns) > 0 ? [true] : []

    content {
      sid       = "DecryptOnlyConfiguredSsmKeys"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = var.ssm_kms_key_arns

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["ssm.${data.aws_region.current.name}.amazonaws.com"]
      }
    }
  }
}

data "aws_region" "current" {}

resource "aws_iam_role_policy" "dispatcher" {
  name   = "${var.function_name}-least-privilege"
  role   = aws_iam_role.dispatcher.id
  policy = data.aws_iam_policy_document.dispatcher_permissions.json
}

resource "aws_lambda_function" "dispatcher" {
  function_name = var.function_name
  description   = "Track-aware transcription dispatcher (${var.release_id})"
  role          = aws_iam_role.dispatcher.arn
  runtime       = "nodejs22.x"
  handler       = var.handler
  architectures = ["arm64"]

  s3_bucket         = var.artifact_s3_bucket
  s3_key            = var.artifact_s3_key
  s3_object_version = var.artifact_s3_object_version
  source_code_hash  = var.artifact_sha256_base64

  timeout                        = var.timeout_seconds
  memory_size                    = var.memory_size
  reserved_concurrent_executions = var.reserved_concurrency

  ephemeral_storage {
    size = var.ephemeral_storage_size
  }

  vpc_config {
    subnet_ids         = var.vpc_subnet_ids
    security_group_ids = var.vpc_security_group_ids
  }

  environment {
    variables = local.base_environment
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_iam_role_policy.dispatcher]

  lifecycle {
    precondition {
      condition     = strcontains(var.artifact_s3_key, var.release_id)
      error_message = "artifact_s3_key must contain the unique release_id so a mutable ZIP key cannot be selected."
    }

    precondition {
      condition     = var.timeout_seconds - var.work_budget_seconds >= var.completion_reserve_seconds
      error_message = "Lambda timeout must leave at least 60 seconds after the bounded provider work budget for validation, upload, and lease completion."
    }

    precondition {
      condition     = var.reserved_concurrency >= 3
      error_message = "reserved_concurrency must be at least 3 so reconciliation can service every durable queue."
    }

    precondition {
      condition     = !var.deepinfra_enabled || (length(var.deepinfra_execution_identity_pin) > 0 && length(var.deepinfra_model_version_pin) > 0)
      error_message = "DeepInfra execution identity and model version pins are required when the primary provider is enabled."
    }

    precondition {
      condition     = length(var.vpc_subnet_ids) > 0 && length(var.vpc_security_group_ids) > 0 && var.vpc_egress_mode == "nat"
      error_message = "private subnets, security groups, and an external NAT/proxy egress contract are required."
    }
  }

  tags = {
    chalk_environment             = var.environment_name
    chalk_release_id              = var.release_id
    chalk_release_manifest_digest = var.release_manifest_digest
    chalk_config_digest           = var.config_digest
    chalk_component               = "transcription-dispatcher"
  }
}

resource "aws_sqs_queue" "async_failure" {
  name                      = "${var.function_name}-async-failure"
  message_retention_seconds = 1209600
  kms_master_key_id         = var.failure_queue_kms_key_arn

  tags = {
    chalk_environment = var.environment_name
    chalk_component   = "transcription-dispatcher-async-failure"
  }
}

data "aws_iam_policy_document" "async_failure_queue" {
  statement {
    sid    = "LambdaFailureDestination"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.async_failure.arn]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_lambda_function.dispatcher.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "async_failure" {
  queue_url = aws_sqs_queue.async_failure.id
  policy    = data.aws_iam_policy_document.async_failure_queue.json
}

resource "aws_lambda_function_event_invoke_config" "dispatcher" {
  function_name                = aws_lambda_function.dispatcher.function_name
  maximum_event_age_in_seconds = var.async_max_event_age_seconds
  maximum_retry_attempts       = var.async_maximum_retry_attempts

  destination_config {
    on_failure {
      destination = aws_sqs_queue.async_failure.arn
    }
  }

  depends_on = [aws_sqs_queue_policy.async_failure]
}

resource "aws_sqs_queue" "scheduler_dlq" {
  name                      = "${var.function_name}-scheduler-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = var.failure_queue_kms_key_arn

  tags = {
    chalk_environment = var.environment_name
    chalk_component   = "transcription-dispatcher-scheduler-dlq"
  }
}

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    sid     = "SchedulerAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.function_name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
}

data "aws_iam_policy_document" "scheduler_permissions" {
  statement {
    sid       = "InvokeDispatcherOnly"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.dispatcher.arn]
  }

  statement {
    sid       = "WriteSchedulerDlqOnly"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.scheduler_dlq.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${var.function_name}-scheduler-target"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_permissions.json
}

resource "aws_scheduler_schedule" "reconcile" {
  name                         = var.scheduler_name
  group_name                   = var.scheduler_group_name
  schedule_expression          = "rate(1 minute)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.dispatcher.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = var.scheduler_input_json

    retry_policy {
      maximum_event_age_in_seconds = var.scheduler_max_event_age_seconds
      maximum_retry_attempts       = var.scheduler_maximum_retry_attempts
    }

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
  }

  depends_on = [aws_iam_role_policy.scheduler]
}

data "aws_iam_policy_document" "scheduler_dlq" {
  statement {
    sid       = "SchedulerFailureDestination"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.scheduler_dlq.arn]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_scheduler_schedule.reconcile.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "scheduler_dlq" {
  queue_url = aws_sqs_queue.scheduler_dlq.id
  policy    = data.aws_iam_policy_document.scheduler_dlq.json
}

resource "aws_lambda_permission" "scheduler" {
  statement_id  = "AllowEventBridgeSchedulerWake"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatcher.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = aws_scheduler_schedule.reconcile.arn
}

resource "aws_lambda_permission" "control_api" {
  count = var.control_api_invoker_principal != null && var.control_api_invoke_source_arn != null ? 1 : 0

  statement_id  = "AllowControlApiWake"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatcher.function_name
  principal     = var.control_api_invoker_principal
  source_arn    = var.control_api_invoke_source_arn
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.function_name}-errors"
  alarm_description   = "Transcription dispatcher invocation errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.dispatcher.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "throttles" {
  alarm_name          = "${var.function_name}-throttles"
  alarm_description   = "Reserved-concurrency throttles on the transcription dispatcher."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.dispatcher.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "async_events_dropped" {
  alarm_name          = "${var.function_name}-async-events-dropped"
  alarm_description   = "Lambda dropped asynchronous transcription wake-up events."
  namespace           = "AWS/Lambda"
  metric_name         = "AsyncEventsDropped"
  dimensions          = { FunctionName = aws_lambda_function.dispatcher.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "async_failure_queue_depth" {
  alarm_name          = "${var.function_name}-async-failure-depth"
  alarm_description   = "Async transcription failure destination contains messages requiring reconciliation."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.async_failure.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "scheduler_target_errors" {
  alarm_name          = "${var.function_name}-scheduler-target-errors"
  alarm_description   = "EventBridge Scheduler could not invoke the transcription dispatcher."
  namespace           = "AWS/Scheduler"
  metric_name         = "TargetErrorCount"
  dimensions          = { ScheduleName = aws_scheduler_schedule.reconcile.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}

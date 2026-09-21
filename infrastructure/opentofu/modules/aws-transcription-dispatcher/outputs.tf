output "lambda_function_arn" {
  description = "Dispatcher Lambda ARN."
  value       = aws_lambda_function.dispatcher.arn
}

output "required_egress_destinations" {
  description = "Outbound service inventory, filtered to enabled providers; not a network-enforced allowlist."
  value       = local.egress_destinations
}

output "lambda_execution_role_arn" {
  description = "Least-privilege dispatcher execution role ARN."
  value       = aws_iam_role.dispatcher.arn
}

output "control_api_invoke_policy_json" {
  description = "Exact least-privilege identity policy that the existing API runtime role must receive to asynchronously wake this dispatcher."
  value = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeTranscriptionDispatcherOnly"
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.dispatcher.arn
    }]
  })
}

output "scheduler_arn" {
  description = "One-minute EventBridge Scheduler reconciliation schedule ARN."
  value       = aws_scheduler_schedule.reconcile.arn
}

output "async_failure_queue_arn" {
  description = "Lambda async failure destination queue ARN."
  value       = aws_sqs_queue.async_failure.arn
}

output "scheduler_dlq_arn" {
  description = "EventBridge Scheduler target DLQ ARN."
  value       = aws_sqs_queue.scheduler_dlq.arn
}

output "artifact_identity" {
  description = "Digest-addressed ZIP identity selected by this module."
  value = {
    bucket        = var.artifact_s3_bucket
    key           = var.artifact_s3_key
    version_id    = var.artifact_s3_object_version
    sha256        = var.artifact_sha256
    sha256_base64 = var.artifact_sha256_base64
  }
}

output "release_identity" {
  description = "Release identity exposed to promotion and verification tooling."
  value = {
    environment             = var.environment_name
    release_id              = var.release_id
    release_manifest_digest = var.release_manifest_digest
    config_digest           = var.config_digest
  }
}

output "log_group_name" {
  description = "CloudWatch log group for the dispatcher."
  value       = aws_cloudwatch_log_group.dispatcher.name
}

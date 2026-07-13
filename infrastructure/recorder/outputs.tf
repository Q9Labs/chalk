output "desired_capture_nodes" {
  description = "Formula-derived capture node count, including the ready spare."
  value       = local.desired_capture_nodes
}

output "desired_render_nodes" {
  description = "Render node count requested by the deadline-aware scaler."
  value       = local.desired_render_nodes
}

output "global_recorder_compute_nodes" {
  description = "Capture plus render nodes subject to the global twenty-one-node cap."
  value       = local.global_compute_nodes
}

output "recording_bucket_name" {
  description = "Private R2 bucket name."
  value       = local.bucket_name
}

output "recording_kms_key_arn" {
  description = "Singapore recording KEK ARN, omitted during validation-only runs."
  value       = try(aws_kms_key.recording[0].arn, null)
  sensitive   = true
}

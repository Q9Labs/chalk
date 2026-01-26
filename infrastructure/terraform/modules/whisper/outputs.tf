# Whisper Module Outputs

output "security_group_id" {
  description = "ID of the Whisper security group"
  value       = aws_security_group.whisper.id
}

output "iam_role_arn" {
  description = "ARN of the Whisper IAM role"
  value       = aws_iam_role.whisper.arn
}

output "iam_role_name" {
  description = "Name of the Whisper IAM role"
  value       = aws_iam_role.whisper.name
}

output "autoscaling_group_name" {
  description = "Name of the Auto Scaling group"
  value       = aws_autoscaling_group.whisper.name
}

output "autoscaling_group_arn" {
  description = "ARN of the Auto Scaling group"
  value       = aws_autoscaling_group.whisper.arn
}

output "launch_template_id" {
  description = "ID of the launch template"
  value       = aws_launch_template.whisper.id
}

output "log_group_name" {
  description = "Name of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.whisper.name
}

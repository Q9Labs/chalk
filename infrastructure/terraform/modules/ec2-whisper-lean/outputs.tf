output "instance_id" {
  description = "Lean whisper worker EC2 instance ID"
  value       = try(data.aws_instances.whisper.ids[0], null)
}

output "public_ip" {
  description = "Lean whisper worker public IP"
  value       = try(data.aws_instance.whisper[0].public_ip, null)
}

output "security_group_id" {
  description = "Security group ID"
  value       = aws_security_group.whisper.id
}

output "instance_profile_name" {
  description = "Instance profile name"
  value       = aws_iam_instance_profile.instance.name
}

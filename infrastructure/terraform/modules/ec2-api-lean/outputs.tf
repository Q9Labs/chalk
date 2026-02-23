output "instance_id" {
  description = "Lean API EC2 instance ID"
  value       = aws_instance.api.id
}

output "public_ip" {
  description = "Lean API public IP"
  value       = aws_eip.api.public_ip
}

output "security_group_id" {
  description = "Security group ID"
  value       = aws_security_group.api.id
}

output "instance_profile_name" {
  description = "Instance profile name"
  value       = aws_iam_instance_profile.instance.name
}

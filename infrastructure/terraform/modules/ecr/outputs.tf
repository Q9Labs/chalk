output "repository_url" {
  description = "ECR repository URL"
  value       = aws_ecr_repository.api.repository_url
}

output "repository_arn" {
  description = "ECR repository ARN"
  value       = aws_ecr_repository.api.arn
}

output "repository_name" {
  description = "ECR repository name"
  value       = aws_ecr_repository.api.name
}

output "registry_id" {
  description = "ECR registry ID"
  value       = aws_ecr_repository.api.registry_id
}

output "docker_push_commands" {
  description = "Docker commands to push image"
  value       = <<-EOT
    aws ecr get-login-password --region ${data.aws_region.current.name} | docker login --username AWS --password-stdin ${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com
    docker build -t ${aws_ecr_repository.api.repository_url}:latest .
    docker push ${aws_ecr_repository.api.repository_url}:latest
  EOT
}

output "whisper_repository_url" {
  description = "ECR repository URL for whisper worker"
  value       = aws_ecr_repository.whisper.repository_url
}

output "whisper_repository_arn" {
  description = "ECR repository ARN for whisper worker"
  value       = aws_ecr_repository.whisper.arn
}

output "whisper_repository_name" {
  description = "ECR repository name for whisper worker"
  value       = aws_ecr_repository.whisper.name
}

output "kms_key_arn" {
  description = "KMS key ARN for secrets"
  value       = aws_kms_key.secrets.arn
}

output "kms_key_id" {
  description = "KMS key ID for secrets"
  value       = aws_kms_key.secrets.key_id
}

output "jwt_secret_arn" {
  description = "JWT secret ARN"
  value       = aws_secretsmanager_secret.jwt_secret.arn
}

output "cloudflare_secret_arn" {
  description = "Cloudflare credentials secret ARN"
  value       = aws_secretsmanager_secret.cloudflare_api.arn
}

output "api_config_secret_arn" {
  description = "API config secret ARN"
  value       = aws_secretsmanager_secret.api_config.arn
}

output "github_token_arn" {
  description = "GitHub token secret ARN for What's New API"
  value       = aws_secretsmanager_secret.github_token.arn
}

output "secrets_read_policy_arn" {
  description = "IAM policy ARN for reading secrets"
  value       = aws_iam_policy.secrets_read.arn
}

output "secret_arns" {
  description = "All secret ARNs"
  value = [
    aws_secretsmanager_secret.jwt_secret.arn,
    aws_secretsmanager_secret.cloudflare_api.arn,
    aws_secretsmanager_secret.api_config.arn,
    aws_secretsmanager_secret.github_token.arn
  ]
}

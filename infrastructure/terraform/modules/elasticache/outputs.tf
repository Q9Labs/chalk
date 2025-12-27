output "replication_group_id" {
  description = "Redis replication group ID"
  value       = aws_elasticache_replication_group.redis.id
}

output "replication_group_arn" {
  description = "Redis replication group ARN"
  value       = aws_elasticache_replication_group.redis.arn
}

output "primary_endpoint" {
  description = "Redis primary endpoint address"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "reader_endpoint" {
  description = "Redis reader endpoint address"
  value       = aws_elasticache_replication_group.redis.reader_endpoint_address
}

output "port" {
  description = "Redis port"
  value       = aws_elasticache_replication_group.redis.port
}

output "security_group_id" {
  description = "Redis security group ID"
  value       = aws_security_group.redis.id
}

output "auth_token_secret_arn" {
  description = "ARN of the secret containing Redis AUTH token"
  value       = try(aws_secretsmanager_secret.redis_auth[0].arn, null)
}

output "kms_key_arn" {
  description = "KMS key ARN used for encryption"
  value       = var.create_kms_key ? aws_kms_key.redis[0].arn : var.kms_key_id
}

output "connection_url_template" {
  description = "Template for Redis connection URL"
  value       = "rediss://:${var.auth_token != null ? "<auth_token>" : "<see_secrets_manager>"}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}"
  sensitive   = true
}

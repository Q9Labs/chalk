output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.ecs.cluster_name
}

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = module.ecs.alb_dns_name
}

output "http_api_endpoint" {
  description = "HTTP API Gateway endpoint"
  value       = module.api_gateway.http_api_endpoint
}

output "websocket_api_endpoint" {
  description = "WebSocket API Gateway endpoint"
  value       = module.api_gateway.websocket_api_endpoint
}

output "api_domain" {
  description = "API custom domain"
  value       = var.api_domain_name
}

output "frontend_domain" {
  description = "Frontend domain"
  value       = "chalk.${var.cloudflare_zone_name}"
}

output "certificate_arn" {
  description = "ACM certificate ARN"
  value       = module.dns.certificate_arn
}

output "aurora_endpoint" {
  description = "Aurora cluster endpoint"
  value       = module.aurora.cluster_endpoint
}

output "aurora_reader_endpoint" {
  description = "Aurora cluster reader endpoint"
  value       = module.aurora.cluster_reader_endpoint
}

output "aurora_secret_arn" {
  description = "Aurora master password secret ARN"
  value       = module.aurora.master_user_secret_arn
}

output "redis_endpoint" {
  description = "Redis primary endpoint"
  value       = module.elasticache.primary_endpoint
}

output "redis_reader_endpoint" {
  description = "Redis reader endpoint"
  value       = module.elasticache.reader_endpoint
}

output "redis_auth_secret_arn" {
  description = "Redis AUTH token secret ARN"
  value       = module.elasticache.auth_token_secret_arn
}

output "ecr_repository_url" {
  description = "ECR repository URL"
  value       = module.ecr.repository_url
}

output "secrets_read_policy_arn" {
  description = "IAM policy ARN for reading secrets"
  value       = module.secrets.secrets_read_policy_arn
}

output "waf_web_acl_arn" {
  description = "WAF Web ACL ARN"
  value       = module.waf.web_acl_arn
}

output "dashboard_url" {
  description = "CloudWatch dashboard URL"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${module.monitoring.dashboard_name}"
}

output "sns_alerts_topic_arn" {
  description = "SNS topic ARN for alerts"
  value       = module.monitoring.sns_topic_arn
}

# Cloudflare outputs
output "cloudflare_sfu_app_id" {
  description = "Cloudflare Calls SFU App ID for RealtimeKit"
  value       = module.cloudflare.sfu_app_id
}

output "cloudflare_recordings_bucket" {
  description = "R2 bucket name for recordings"
  value       = module.cloudflare.recordings_bucket_name
}

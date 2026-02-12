output "api_endpoint" {
  description = "URL for the stress test API"
  value       = "http://${aws_lb.stress.dns_name}"
}

output "load_generator_ips" {
  description = "Private IPs of load generator instances"
  value       = aws_instance.load_generator[*].private_ip
}

output "cloudwatch_dashboard_url" {
  description = "URL for the CloudWatch dashboard"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.stress.dashboard_name}"
}

output "aurora_endpoint" {
  description = "Aurora cluster endpoint"
  value       = aws_rds_cluster.stress.endpoint
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = aws_elasticache_replication_group.stress.primary_endpoint_address
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.stress.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.api.name
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix for CloudWatch metrics"
  value       = aws_lb.stress.arn_suffix
}

output "target_group_arn_suffix" {
  description = "ALB target group ARN suffix for CloudWatch metrics"
  value       = aws_lb_target_group.api.arn_suffix
}

output "aurora_cluster_identifier" {
  description = "Aurora cluster identifier"
  value       = aws_rds_cluster.stress.cluster_identifier
}

output "redis_replication_group_id" {
  description = "ElastiCache replication group ID"
  value       = aws_elasticache_replication_group.stress.id
}

output "ecr_repository_url" {
  description = "ECR repository URL for the API image"
  value       = aws_ecr_repository.api.repository_url
}

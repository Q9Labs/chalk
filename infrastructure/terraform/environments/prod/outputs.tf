output "api_domain" {
  description = "Lean API domain"
  value       = local.api_domain
}

output "ws_domain" {
  description = "Lean WebSocket domain"
  value       = local.ws_domain
}

output "api_public_ip" {
  description = "Lean API public IP"
  value       = module.ec2_api.public_ip
}

output "api_instance_id" {
  description = "Lean API EC2 instance ID"
  value       = module.ec2_api.instance_id
}

output "ecr_repository_url" {
  description = "Lean API ECR repository"
  value       = module.ecr.repository_url
}

output "r2_bucket_name" {
  description = "R2 recordings bucket"
  value       = module.cloudflare.recordings_bucket_name
}

output "upstash_endpoint" {
  description = "Upstash Redis endpoint"
  value       = upstash_redis_database.control_plane.endpoint
}

output "upstash_port" {
  description = "Upstash Redis port"
  value       = upstash_redis_database.control_plane.port
}

output "planetscale_host" {
  description = "PlanetScale branch role host"
  value       = planetscale_postgres_branch_role.api.access_host_url
}

output "ssm_parameter_path" {
  description = "Runtime env parameter path"
  value       = var.ssm_parameter_path
}

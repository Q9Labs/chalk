variable "aws_region" {
  description = "AWS region for stress test infrastructure"
  type        = string
  default     = "us-east-1"
}

variable "api_image" {
  description = "Docker image for the API service"
  type        = string
  default     = ""
}

variable "db_username" {
  description = "Aurora database master username"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Aurora database master password"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID for RealtimeKit"
  type        = string
  sensitive   = true
}

variable "cloudflare_app_id" {
  description = "Cloudflare RealtimeKit app ID"
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token for RealtimeKit"
  type        = string
  sensitive   = true
}

variable "cloudflare_mock" {
  description = "Whether to mock Cloudflare calls in the API"
  type        = bool
  default     = false
}

variable "ecs_task_cpu" {
  description = "ECS task CPU units"
  type        = number
  default     = 256
}

variable "ecs_task_memory" {
  description = "ECS task memory (MiB)"
  type        = number
  default     = 512
}

variable "ecs_desired_count" {
  description = "ECS service desired count"
  type        = number
  default     = 1
}

variable "db_instance_class" {
  description = "RDS Aurora instance class"
  type        = string
  default     = "db.serverless"
}

variable "db_instance_count" {
  description = "Number of RDS cluster instances"
  type        = number
  default     = 1
}

variable "aurora_min_capacity" {
  description = "Aurora Serverless v2 min ACU"
  type        = number
  default     = 0.5
}

variable "aurora_max_capacity" {
  description = "Aurora Serverless v2 max ACU"
  type        = number
  default     = 2
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.micro"
}

variable "redis_num_cache_clusters" {
  description = "Number of Redis cache nodes"
  type        = number
  default     = 2
}

variable "redis_auth_token" {
  description = "Redis AUTH token (leave empty to auto-generate)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "load_generator_instance_type" {
  description = "EC2 instance type for load generators"
  type        = string
  default     = "t3.small"
}

variable "load_generator_count" {
  description = "Number of load generator instances"
  type        = number
  default     = 3
}

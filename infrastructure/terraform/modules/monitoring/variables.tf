variable "environment" {
  description = "Environment name"
  type        = string
}

variable "alert_emails" {
  description = "Email addresses for alerts"
  type        = list(string)
  default     = []
}

variable "ecs_cluster_name" {
  description = "ECS cluster name for monitoring"
  type        = string
  default     = null
}

variable "ecs_service_name" {
  description = "ECS service name for monitoring"
  type        = string
  default     = null
}

variable "alb_arn" {
  description = "ALB ARN for monitoring"
  type        = string
  default     = null
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix for CloudWatch metrics"
  type        = string
  default     = null
}

variable "aurora_cluster_id" {
  description = "Aurora cluster identifier for monitoring"
  type        = string
  default     = null
}

variable "aurora_max_connections" {
  description = "Aurora max connections for threshold calculation"
  type        = number
  default     = 100
}

variable "redis_replication_group_id" {
  description = "Redis replication group ID for monitoring"
  type        = string
  default     = null
}

variable "api_gateway_id" {
  description = "API Gateway ID for monitoring"
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

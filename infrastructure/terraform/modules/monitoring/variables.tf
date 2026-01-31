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

variable "ecs_log_group_name" {
  description = "ECS CloudWatch log group name (for log-based metrics)"
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

variable "alb_target_group_arn_suffix" {
  description = "ALB target group ARN suffix for CloudWatch metrics"
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

variable "enable_ecs_alarms" {
  description = "Enable ECS CloudWatch alarms"
  type        = bool
  default     = true
}

variable "enable_websocket_alarms" {
  description = "Enable WebSocket backpressure CloudWatch alarms (log-based)"
  type        = bool
  default     = true
}

variable "enable_alb_alarms" {
  description = "Enable ALB CloudWatch alarms"
  type        = bool
  default     = true
}

variable "enable_alb_target_alarms" {
  description = "Enable ALB target group CloudWatch alarms"
  type        = bool
  default     = true
}

variable "enable_aurora_alarms" {
  description = "Enable Aurora CloudWatch alarms"
  type        = bool
  default     = true
}

variable "enable_redis_alarms" {
  description = "Enable Redis CloudWatch alarms"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS instances"
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for ALB"
  type        = list(string)
}

variable "instance_type" {
  description = "EC2 instance type for ECS"
  type        = string
  default     = "t3.medium"
}

variable "min_capacity" {
  description = "Minimum number of EC2 instances"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of EC2 instances"
  type        = number
  default     = 4
}

variable "desired_capacity" {
  description = "Desired number of EC2 instances"
  type        = number
  default     = 2
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS listener"
  type        = string
  default     = null
}

variable "enable_https_listener" {
  description = "Enable HTTPS listener (use instead of checking certificate_arn != null)"
  type        = bool
  default     = false
}

variable "internal_alb" {
  description = "Whether ALB should be internal (for API Gateway integration)"
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "enable_alb_access_logs" {
  description = "Enable ALB access logging to S3"
  type        = bool
  default     = false
}

variable "alb_access_logs_prefix" {
  description = "S3 key prefix for ALB access logs"
  type        = string
  default     = "alb"
}

variable "alb_access_logs_retention_days" {
  description = "Retention for ALB access logs in days"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

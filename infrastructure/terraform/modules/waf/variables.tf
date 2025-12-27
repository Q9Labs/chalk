variable "environment" {
  description = "Environment name"
  type        = string
}

variable "rate_limit" {
  description = "Rate limit per IP per 5 minutes"
  type        = number
  default     = 2000
}

variable "http_api_arn" {
  description = "API Gateway HTTP API ARN to associate"
  type        = string
  default     = null
}

variable "alb_arn" {
  description = "ALB ARN to associate"
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

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
  description = "API Gateway HTTP API ARN to associate (deprecated, use http_stage_arn)"
  type        = string
  default     = null
}

variable "http_stage_arn" {
  description = "API Gateway HTTP API Stage ARN for WAF association"
  type        = string
  default     = null
}

variable "enable_http_api_association" {
  description = "Enable WAF association with HTTP API Gateway (use instead of checking http_api_arn != null)"
  type        = bool
  default     = false
}

variable "alb_arn" {
  description = "ALB ARN to associate"
  type        = string
  default     = null
}

variable "enable_alb_association" {
  description = "Enable WAF association with ALB (use instead of checking alb_arn != null)"
  type        = bool
  default     = false
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

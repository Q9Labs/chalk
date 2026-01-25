variable "environment" {
  description = "Environment name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for VPC Link"
  type        = list(string)
}

variable "alb_listener_arn" {
  description = "ALB listener ARN for HTTP integration"
  type        = string
}

variable "alb_dns_name" {
  description = "ALB DNS name"
  type        = string
}

variable "cors_allowed_origins" {
  description = "CORS allowed origins (fallback if S3 bucket not configured)"
  type        = list(string)
  default     = ["*"]
}

variable "cors_origins_bucket" {
  description = "S3 bucket containing aggregated CORS origins (optional)"
  type        = string
  default     = null
}

variable "enable_s3_cors_origins" {
  description = "Whether to read CORS origins from S3 bucket (must be known at plan time)"
  type        = bool
  default     = false
}

variable "cors_origins_key" {
  description = "S3 key for the origins JSON file"
  type        = string
  default     = "cors/allowed-origins.json"
}

variable "throttling_burst_limit" {
  description = "HTTP API throttling burst limit"
  type        = number
  default     = 5000
}

variable "throttling_rate_limit" {
  description = "HTTP API throttling rate limit"
  type        = number
  default     = 10000
}

variable "websocket_throttling_burst_limit" {
  description = "WebSocket API throttling burst limit"
  type        = number
  default     = 2000
}

variable "websocket_throttling_rate_limit" {
  description = "WebSocket API throttling rate limit"
  type        = number
  default     = 5000
}

variable "domain_name" {
  description = "Custom domain name for API"
  type        = string
  default     = null
}

variable "websocket_domain_name" {
  description = "Custom domain name for WebSocket API"
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "ACM certificate ARN for custom domain"
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

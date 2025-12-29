variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "alert_emails" {
  description = "Email addresses for alerts"
  type        = list(string)
  default     = []
}

variable "cors_allowed_origins" {
  description = "CORS allowed origins"
  type        = list(string)
  default     = ["https://chalk.q9labs.com", "https://app.chalk.q9labs.com"]
}

variable "api_domain_name" {
  description = "Custom domain name for API"
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS"
  type        = string
  default     = null
}

variable "cloudflare_app_id" {
  description = "Cloudflare RealtimeKit App ID"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_cloudflare_app_id
}

variable "cloudflare_app_secret" {
  description = "Cloudflare RealtimeKit App Secret"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_cloudflare_app_secret
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with R2 and Calls permissions"
  type        = string
  sensitive   = true
}

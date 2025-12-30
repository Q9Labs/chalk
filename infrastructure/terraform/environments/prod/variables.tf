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
  default     = ["https://chalk.q9labs.ai"]
}

variable "api_domain_name" {
  description = "Custom domain name for API"
  type        = string
  default     = "chalk-api.q9labs.ai"
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone name for DNS"
  type        = string
  default     = "q9labs.ai"
}

variable "frontend_target" {
  description = "Frontend CNAME target (e.g., Cloudflare Pages URL)"
  type        = string
  default     = "chalk-web.pages.dev"
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
  description = "Cloudflare API token with R2, Calls, DNS permissions"
  type        = string
  sensitive   = true
}

variable "enable_cloudflare" {
  description = "Enable Cloudflare resources (SFU, TURN, R2)"
  type        = bool
  default     = true
}

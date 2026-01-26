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

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with R2 and Calls permissions"
  type        = string
  sensitive   = true
}

variable "enable_cloudflare" {
  description = "Enable Cloudflare resources (SFU, TURN, R2)"
  type        = bool
  default     = true
}

# Post-meeting transcription & AI (optional in dev)
variable "groq_api_key" {
  description = "Groq API key for transcription service"
  type        = string
  sensitive   = true
  default     = ""
}

variable "openrouter_api_key" {
  description = "OpenRouter API key for AI summaries and action items"
  type        = string
  sensitive   = true
  default     = ""
}

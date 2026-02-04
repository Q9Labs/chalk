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
  default = [
    "https://chalk.q9labs.ai",
    "https://chalk-5bc.pages.dev",
    "http://localhost:3000",
    "http://localhost:3070",
    "https://collabdash-dev.vercel.app",
    "https://app.collabdash.io",
    "https://dev.d17jmjn2v13h91.amplifyapp.com",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3070",
    "http://127.0.0.1:5173",
    "http://localhost:3090"
  ]
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
  description = "Frontend CNAME target (e.g., Cloudflare Pages URL). Set to null if managed by Cloudflare Pages directly."
  type        = string
  default     = null # Cloudflare Pages auto-creates this DNS record
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

variable "r2_access_key_id" {
  description = "Cloudflare R2 Access Key ID"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_r2_access_key_id
  validation {
    condition     = var.enable_cloudflare == false || var.r2_access_key_id != ""
    error_message = "r2_access_key_id is required when enable_cloudflare is true."
  }
}

variable "r2_secret_access_key" {
  description = "Cloudflare R2 Secret Access Key"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_r2_secret_access_key
  validation {
    condition     = var.enable_cloudflare == false || var.r2_secret_access_key != ""
    error_message = "r2_secret_access_key is required when enable_cloudflare is true."
  }
}

variable "axiom_token" {
  description = "Axiom ingest token for structured logging"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_axiom_token
}

variable "axiom_dataset" {
  description = "Axiom dataset name"
  type        = string
  default     = "chalk-api-prod"
}

# Post-meeting transcription & AI
variable "groq_api_key" {
  description = "Groq API key for transcription service"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_groq_api_key
}

variable "openrouter_api_key" {
  description = "OpenRouter API key for AI summaries and action items"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_openrouter_api_key
}

variable "cloudflare_webhook_secret" {
  description = "Secret for verifying Cloudflare RealtimeKit webhooks"
  type        = string
  sensitive   = true
  default     = "" # Set via -var or TF_VAR_cloudflare_webhook_secret
}

# Admin dashboard
variable "admin_allowed_ips" {
  description = "Comma-separated IPs allowed to access admin endpoints"
  type        = string
  default     = "124.29.228.126"
}

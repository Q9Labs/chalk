variable "environment" {
  description = "Environment name"
  type        = string
}

variable "cloudflare_app_id" {
  description = "Cloudflare RealtimeKit App ID"
  type        = string
  default     = "placeholder-update-after-setup"
  sensitive   = true
}

variable "cloudflare_app_secret" {
  description = "Cloudflare RealtimeKit App Secret"
  type        = string
  default     = "placeholder-update-after-setup"
  sensitive   = true
}

variable "jwt_expiry_hours" {
  description = "JWT token expiry in hours"
  type        = number
  default     = 24
}

variable "turn_app_id" {
  description = "Cloudflare Calls TURN App ID"
  type        = string
  default     = ""
}

variable "turn_app_key" {
  description = "Cloudflare Calls TURN App Key"
  type        = string
  default     = ""
  sensitive   = true
}

variable "r2_access_key_id" {
  description = "Cloudflare R2 Access Key ID"
  type        = string
  default     = ""
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "Cloudflare R2 Secret Access Key"
  type        = string
  default     = ""
  sensitive   = true
}

variable "axiom_token" {
  description = "Axiom ingest token for structured logging"
  type        = string
  default     = ""
  sensitive   = true
}

variable "axiom_dataset" {
  description = "Axiom dataset name"
  type        = string
  default     = "chalk-api"
}

variable "groq_api_key" {
  description = "Groq API key for transcription service"
  type        = string
  default     = ""
  sensitive   = true
}

variable "openrouter_api_key" {
  description = "OpenRouter API key for AI summaries and action items"
  type        = string
  default     = ""
  sensitive   = true
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

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

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

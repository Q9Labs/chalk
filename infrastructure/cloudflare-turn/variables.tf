variable "environment_name" {
  description = "Chalk environment that owns this TURN key, such as nightly or production."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,31}$", var.environment_name))
    error_message = "environment_name must be a short lowercase name."
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account identifier supplied through private environment configuration."
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Calls write access to the account."
  type        = string
  sensitive   = true
}

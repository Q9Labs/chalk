variable "enabled" {
  description = "Enable Cloudflare resources (set to false if credentials not configured)"
  type        = bool
  default     = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID"
  type        = string
}

variable "project" {
  description = "Project name"
  type        = string
  default     = "chalk"
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
}

variable "r2_location" {
  description = "R2 bucket location (apac, eeur, enam, weur, wnam, oc)"
  type        = string
  default     = "enam" # Eastern North America - close to us-east-1
}

variable "recording_retention_days" {
  description = "Days to retain recordings before deletion (0 = never delete)"
  type        = number
  default     = 90
}

variable "enable_lifecycle_rules" {
  description = "Enable R2 lifecycle rule management"
  type        = bool
  default     = true
}

variable "enable_r2_cors" {
  description = "Enable browser CORS rules for the R2 recordings bucket"
  type        = bool
  default     = true
}

variable "r2_cors_allowed_origins" {
  description = "Allowed browser origins for presigned R2 object access"
  type        = list(string)
  default     = ["*"]
}

variable "r2_cors_allowed_methods" {
  description = "Allowed browser methods for presigned R2 object access"
  type        = list(string)
  default     = ["GET", "HEAD", "PUT"]
}

variable "r2_cors_allowed_headers" {
  description = "Allowed request headers for browser preflight on R2 object access"
  type        = list(string)
  default     = ["*"]
}

variable "r2_cors_expose_headers" {
  description = "Response headers exposed to browser clients for R2 object access"
  type        = list(string)
  default     = ["ETag"]
}

variable "r2_cors_max_age_seconds" {
  description = "Browser preflight cache TTL for R2 CORS rules"
  type        = number
  default     = 3600
}

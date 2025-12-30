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

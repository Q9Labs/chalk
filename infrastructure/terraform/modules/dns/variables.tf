variable "environment" {
  description = "Environment name"
  type        = string
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone name (e.g., q9labs.ai)"
  type        = string
}

variable "api_domain" {
  description = "Full API domain (e.g., chalk-api.q9labs.ai)"
  type        = string
}

variable "api_subdomain" {
  description = "API subdomain without zone (e.g., chalk-api)"
  type        = string
}

variable "api_gateway_domain_target" {
  description = "API Gateway custom domain target (from API Gateway module output)"
  type        = string
  default     = null
}

variable "frontend_subdomain" {
  description = "Frontend subdomain without zone (e.g., chalk)"
  type        = string
  default     = null
}

variable "frontend_target" {
  description = "Frontend target (Cloudflare Pages URL or other CNAME target)"
  type        = string
  default     = null
}

variable "cloudflare_proxy_enabled" {
  description = "Enable Cloudflare proxy (orange cloud) for DNS records"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

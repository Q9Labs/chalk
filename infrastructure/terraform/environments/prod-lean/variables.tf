variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone name"
  type        = string
  default     = "q9labs.ai"
}

variable "api_subdomain" {
  description = "API subdomain"
  type        = string
  default     = "chalk-api"
}

variable "ws_subdomain" {
  description = "WebSocket subdomain"
  type        = string
  default     = "chalk-ws"
}

variable "cloudflare_proxy_enabled" {
  description = "Enable Cloudflare proxy for DNS records"
  type        = bool
  default     = false
}

variable "manage_dns_records" {
  description = "Manage chalk-api/chalk-ws DNS records from this stack"
  type        = bool
  default     = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token"
  type        = string
  sensitive   = true
}

variable "r2_access_key_id" {
  description = "Cloudflare R2 access key ID"
  type        = string
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "Cloudflare R2 secret access key"
  type        = string
  sensitive   = true
}

variable "upstash_email" {
  description = "Upstash account email"
  type        = string
}

variable "upstash_api_key" {
  description = "Upstash API key"
  type        = string
  sensitive   = true
}

variable "upstash_region" {
  description = "Upstash Redis region"
  type        = string
  default     = "us-east-1"
}

variable "upstash_database_name" {
  description = "Upstash Redis database name"
  type        = string
  default     = "chalk-prod"
}

variable "upstash_tls" {
  description = "Enable Upstash TLS"
  type        = bool
  default     = true
}

variable "upstash_eviction" {
  description = "Enable Upstash eviction"
  type        = bool
  default     = false
}

variable "planetscale_service_token_id" {
  description = "PlanetScale service token ID"
  type        = string
  sensitive   = true
}

variable "planetscale_service_token" {
  description = "PlanetScale service token"
  type        = string
  sensitive   = true
}

variable "planetscale_organization" {
  description = "PlanetScale organization"
  type        = string
}

variable "planetscale_database" {
  description = "PlanetScale Postgres database"
  type        = string
}

variable "planetscale_database_name" {
  description = "Actual Postgres database name within PlanetScale cluster"
  type        = string
  default     = "postgres"
}

variable "planetscale_branch" {
  description = "PlanetScale branch"
  type        = string
  default     = "main"
}

variable "cloudflare_app_id" {
  description = "RealtimeKit app ID"
  type        = string
}

variable "cloudflare_app_token" {
  description = "RealtimeKit API token"
  type        = string
  sensitive   = true
}

variable "post_meeting_cloudflare_api_token" {
  description = "Cloudflare Workers AI API token for post-meeting transcription"
  type        = string
  sensitive   = true
  default     = ""
}

variable "post_meeting_cloudflare_worker_url" {
  description = "Cloudflare Worker URL for post-meeting transcription dispatch"
  type        = string
  default     = "https://chalk-transcription.q9labs.ai"
}

variable "post_meeting_cloudflare_worker_dispatch_secret" {
  description = "Shared secret used by Chalk API to sign Cloudflare worker dispatch requests"
  type        = string
  sensitive   = true
  default     = ""
}

variable "post_meeting_cloudflare_worker_callback_secret" {
  description = "Shared secret used by the Cloudflare worker to sign callback requests back to Chalk API"
  type        = string
  sensitive   = true
  default     = ""
}

variable "jwt_signing_key" {
  description = "JWT signing key"
  type        = string
  sensitive   = true
}

variable "admin_secret" {
  description = "Admin API secret"
  type        = string
  sensitive   = true
}

variable "auth_link_signing_key" {
  description = "Auth link signing key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "resend_api_key" {
  description = "Resend API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "resend_from_email" {
  description = "Resend sender email"
  type        = string
  default     = "notifications@notifications.q9labs.ai"
}

variable "internal_app_url" {
  description = "Internal app URL for magic links"
  type        = string
  default     = "https://chalkmeet.com"
}

variable "internal_app_urls" {
  description = "Comma-separated internal app URLs for magic links"
  type        = string
  default     = "https://chalkmeet.com,https://chalk.q9labs.ai"
}

variable "auth_cookie_domain" {
  description = "Auth cookie domain"
  type        = string
  default     = ".q9labs.ai"
}

variable "axiom_token" {
  description = "Axiom token"
  type        = string
  sensitive   = true
  default     = ""
}

variable "axiom_dataset" {
  description = "Axiom dataset"
  type        = string
  default     = "chalk-api-prod"
}

variable "axiom_traces_dataset" {
  description = "Axiom traces dataset"
  type        = string
  default     = "chalk-prod-traces"
}

variable "github_token" {
  description = "GitHub token for whats-new cache refresh"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_owner" {
  description = "GitHub owner"
  type        = string
  default     = "Q9Labs"
}

variable "github_repo" {
  description = "GitHub repo"
  type        = string
  default     = "chalk"
}

variable "openrouter_api_key" {
  description = "OpenRouter API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "groq_api_key" {
  description = "Groq API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_webhook_secret" {
  description = "Cloudflare webhook secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_allowed_ips" {
  description = "Comma-separated allowed admin IPs"
  type        = string
  default     = "124.29.228.126"
}

variable "db_max_conns" {
  description = "Database max pool connections"
  type        = number
  default     = 12
}

variable "db_min_conns" {
  description = "Database min pool connections"
  type        = number
  default     = 1
}

variable "ssm_parameter_path" {
  description = "Path where runtime env vars are stored"
  type        = string
  default     = "/chalk/prod/api"
}

variable "instance_type" {
  description = "Lean API instance type"
  type        = string
  default     = "t4g.micro"
}

variable "alert_actions" {
  description = "Optional CloudWatch alarm actions"
  type        = list(string)
  default     = []
}

variable "ssh_ingress_cidrs" {
  description = "Optional SSH CIDR allowlist"
  type        = list(string)
  default     = []
}

variable "whisper_enabled" {
  description = "Enable dedicated whisper worker in lean stack"
  type        = bool
  default     = false
}

variable "whisper_instance_type" {
  description = "Lean whisper worker EC2 instance type"
  type        = string
  default     = "c7i.xlarge"
}

variable "whisper_use_spot" {
  description = "Use spot market for lean whisper worker"
  type        = bool
  default     = true
}

variable "whisper_ssm_parameter_path" {
  description = "SSM path where whisper worker reads secrets/env"
  type        = string
  default     = "/chalk/prod/api"
}

variable "whisper_log_level" {
  description = "Whisper worker log level"
  type        = string
  default     = "INFO"
}

variable "whisper_device" {
  description = "Whisper worker inference device"
  type        = string
  default     = "cpu"
}

variable "whisper_compute_type" {
  description = "Whisper worker compute type"
  type        = string
  default     = "int8"
}

variable "whisper_cpu_threads" {
  description = "Whisper worker CPU threads"
  type        = number
  default     = 4
}

variable "whisper_gpu_metrics_enabled" {
  description = "Enable whisper worker GPU metrics"
  type        = bool
  default     = false
}

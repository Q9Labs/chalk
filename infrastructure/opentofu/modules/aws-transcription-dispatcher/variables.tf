variable "function_name" {
  description = "Globally unique Lambda function name for this environment."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9-_]{1,64}$", var.function_name))
    error_message = "function_name must be a valid Lambda name (1-64 letters, digits, hyphens, or underscores)."
  }
}

variable "environment_name" {
  description = "Environment identity embedded in runtime configuration and telemetry."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,31}$", var.environment_name))
    error_message = "environment_name must be a lowercase deployment name (for example, staging or production)."
  }
}

variable "release_id" {
  description = "Unique release identity; artifact_s3_key must contain this value."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$", var.release_id)) && !strcontains(lower(var.release_id), "latest")
    error_message = "release_id must be unique, non-mutable, and at least eight characters; latest is not allowed."
  }
}

variable "release_manifest_digest" {
  description = "SHA-256 digest of the signed release manifest."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.release_manifest_digest))
    error_message = "release_manifest_digest must be a sha256:<64 lowercase hex> digest."
  }
}

variable "config_digest" {
  description = "SHA-256 digest of the non-secret environment runtime configuration."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.config_digest))
    error_message = "config_digest must be a sha256:<64 lowercase hex> digest."
  }
}

variable "artifact_s3_bucket" {
  description = "Pre-existing private, versioned S3 release-artifact bucket. This module never uploads artifacts."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.artifact_s3_bucket))
    error_message = "artifact_s3_bucket must be a valid S3 bucket name."
  }
}

variable "artifact_s3_key" {
  description = "Unique ZIP object key containing release_id; never use a mutable latest key."
  type        = string

  validation {
    condition     = length(trimspace(var.artifact_s3_key)) > 0 && !strcontains(lower(var.artifact_s3_key), "latest")
    error_message = "artifact_s3_key must be a non-empty immutable key and cannot contain latest."
  }
}

variable "artifact_s3_object_version" {
  description = "Exact S3 object version ID for the release ZIP."
  type        = string

  validation {
    condition     = length(trimspace(var.artifact_s3_object_version)) > 0 && !strcontains(lower(var.artifact_s3_object_version), "latest") && lower(trimspace(var.artifact_s3_object_version)) != "null"
    error_message = "artifact_s3_object_version must be a concrete S3 version ID; null/latest are not allowed."
  }
}

variable "artifact_sha256" {
  description = "Lowercase SHA-256 digest of the exact Lambda ZIP bytes."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.artifact_sha256))
    error_message = "artifact_sha256 must be exactly 64 lowercase hexadecimal characters."
  }
}

variable "artifact_sha256_base64" {
  description = "Base64 encoding of the raw SHA-256 bytes for AWS Lambda source_code_hash, produced by the release verifier."
  type        = string

  validation {
    condition     = can(base64decode(var.artifact_sha256_base64)) && length(base64decode(var.artifact_sha256_base64)) == 32
    error_message = "artifact_sha256_base64 must decode to exactly 32 SHA-256 bytes."
  }
}

variable "handler" {
  description = "Node.js Lambda handler."
  type        = string
  default     = "index.handler"

  validation {
    condition     = can(regex("^[A-Za-z0-9_./-]+$", var.handler))
    error_message = "handler must be a valid module.handler name."
  }
}

variable "timeout_seconds" {
  description = "Lambda timeout in seconds; bounded to AWS's 1-900 second range."
  type        = number
  default     = 600

  validation {
    condition     = var.timeout_seconds >= 61 && var.timeout_seconds <= 900 && floor(var.timeout_seconds) == var.timeout_seconds
    error_message = "timeout_seconds must be an integer between 61 and 900 seconds."
  }
}

variable "work_budget_seconds" {
  description = "Maximum provider/chunk work budget, leaving completion_reserve_seconds for validation, upload, and lease completion."
  type        = number
  default     = 300

  validation {
    condition     = var.work_budget_seconds >= 1 && floor(var.work_budget_seconds) == var.work_budget_seconds
    error_message = "work_budget_seconds must be a positive integer."
  }
}

variable "completion_reserve_seconds" {
  description = "Minimum completion reserve required after bounded provider work."
  type        = number
  default     = 60

  validation {
    condition     = var.completion_reserve_seconds >= 60 && floor(var.completion_reserve_seconds) == var.completion_reserve_seconds
    error_message = "completion_reserve_seconds must be at least 60 seconds."
  }
}

variable "reserved_concurrency" {
  description = "Reserved Lambda concurrency. It is capped at the launch burst and must leave capacity for all reconciliation queues."
  type        = number
  default     = 50

  validation {
    condition     = var.reserved_concurrency >= 3 && var.reserved_concurrency <= 50 && floor(var.reserved_concurrency) == var.reserved_concurrency
    error_message = "reserved_concurrency must be an integer from 3 through 50 so reconciliation can service every durable queue."
  }
}

variable "memory_size" {
  description = "Bounded Lambda memory size in MB."
  type        = number
  default     = 1024

  validation {
    condition     = var.memory_size >= 128 && var.memory_size <= 4096 && floor(var.memory_size) == var.memory_size
    error_message = "memory_size must be an integer between 128 and 4096 MB."
  }
}

variable "ephemeral_storage_size" {
  description = "Bounded Lambda /tmp storage size in MB."
  type        = number
  default     = 1024

  validation {
    condition     = var.ephemeral_storage_size >= 512 && var.ephemeral_storage_size <= 4096 && floor(var.ephemeral_storage_size) == var.ephemeral_storage_size
    error_message = "ephemeral_storage_size must be an integer between 512 and 4096 MB."
  }
}

variable "vpc_subnet_ids" {
  description = "Private subnet IDs for provider/API egress. A NAT firewall or HTTPS proxy is required outside this module."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.vpc_subnet_ids) > 0
    error_message = "at least one private subnet is required; the dispatcher must not run without a controlled egress path."
  }
}

variable "vpc_security_group_ids" {
  description = "Security groups for the controlled VPC attachment."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.vpc_security_group_ids) > 0
    error_message = "at least one security group is required for the controlled VPC egress path."
  }
}

variable "vpc_egress_mode" {
  description = "Documented egress path for a VPC-attached function; an external NAT firewall or HTTPS proxy must allow only the control API, providers, SSM/KMS, and telemetry."
  type        = string
  default     = "nat"

  validation {
    condition     = var.vpc_egress_mode == "nat"
    error_message = "vpc_egress_mode must be nat; interface endpoints cannot reach DeepInfra or Cloudflare AI APIs."
  }
}

variable "vpc_egress_allowlist" {
  description = "Documented HTTPS egress destinations enforced outside this module by the NAT firewall or proxy."
  type        = set(string)
  default = [
    "control-api",
    "api.deepinfra.com",
    "api.cloudflare.com",
    "ssm",
    "kms",
    "telemetry",
  ]

  validation {
    condition     = contains(var.vpc_egress_allowlist, "control-api") && contains(var.vpc_egress_allowlist, "api.deepinfra.com") && contains(var.vpc_egress_allowlist, "api.cloudflare.com") && contains(var.vpc_egress_allowlist, "ssm") && contains(var.vpc_egress_allowlist, "kms") && contains(var.vpc_egress_allowlist, "telemetry")
    error_message = "vpc_egress_allowlist must document control API, DeepInfra, Cloudflare AI, SSM, KMS, and telemetry destinations."
  }
}

variable "control_api_url" {
  description = "Authenticated recorder control API URL; no provider or object credentials are placed in Lambda environment variables."
  type        = string

  validation {
    condition     = can(regex("^https://", var.control_api_url))
    error_message = "control_api_url must use HTTPS."
  }
}

variable "control_api_audience" {
  description = "Non-secret audience bound into the replay-resistant control API workload HMAC signature."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", var.control_api_audience))
    error_message = "control_api_audience must be a bounded non-secret audience identifier."
  }
}

variable "max_batch" {
  description = "Maximum bounded job assignments claimed per invocation."
  type        = number
  default     = 10

  validation {
    condition     = var.max_batch >= 3 && var.max_batch <= 50 && floor(var.max_batch) == var.max_batch
    error_message = "max_batch must be an integer from 3 through 50 so reconciliation cannot starve a durable queue."
  }
}

variable "privacy_gate_accepted" {
  description = "Release-approved provider privacy/commercial gate. This must be explicitly true for a deployable dispatcher."
  type        = bool
}

variable "deepinfra_enabled" {
  description = "Whether the release enables DeepInfra as the primary provider."
  type        = bool
  default     = false
}

variable "deepinfra_execution_identity_pin" {
  description = "Pinned DeepInfra execution identity, required when DeepInfra is enabled."
  type        = string
  default     = ""
}

variable "deepinfra_model_version_pin" {
  description = "Pinned DeepInfra model/version contract, required when DeepInfra is enabled."
  type        = string
  default     = ""
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID used by the fallback adapter."
  type        = string

  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase account ID."
  }
}

variable "cloudflare_model_slug" {
  description = "Release-qualified Cloudflare Workers AI model slug."
  type        = string
  default     = "@cf/openai/whisper-large-v3-turbo"

  validation {
    condition     = var.cloudflare_model_slug == "@cf/openai/whisper-large-v3-turbo"
    error_message = "cloudflare_model_slug must remain the release-qualified Whisper model."
  }
}

variable "cloudflare_adapter_contract_version" {
  description = "Versioned Cloudflare adapter contract."
  type        = string
}

variable "cloudflare_corpus_digest" {
  description = "Digest of the last passing Cloudflare conformance corpus."
  type        = string

  validation {
    condition     = can(regex("^[a-fA-F0-9]{32,128}$", var.cloudflare_corpus_digest))
    error_message = "cloudflare_corpus_digest must be a hexadecimal corpus digest."
  }
}

variable "provider_timeout_ms" {
  description = "Bounded provider request timeout."
  type        = number
  default     = 90000

  validation {
    condition     = var.provider_timeout_ms >= 100 && var.provider_timeout_ms <= 120000 && floor(var.provider_timeout_ms) == var.provider_timeout_ms
    error_message = "provider_timeout_ms must be an integer from 100 through 120000."
  }
}

variable "max_audio_bytes" {
  description = "Maximum bounded audio chunk bytes."
  type        = number
  default     = 50 * 1024 * 1024
}

variable "max_audio_seconds" {
  description = "Maximum bounded audio chunk duration."
  type        = number
  default     = 900
}

variable "max_response_bytes" {
  description = "Maximum bounded provider response bytes."
  type        = number
  default     = 25 * 1024 * 1024
}

variable "max_text_chars" {
  description = "Maximum normalized provider text characters."
  type        = number
  default     = 2000000
}

variable "max_segments" {
  description = "Maximum provider segments in one bounded response."
  type        = number
  default     = 100000
}

variable "max_words" {
  description = "Maximum provider words in one bounded response."
  type        = number
  default     = 500000
}

variable "provider_max_retries" {
  description = "Dispatcher provider retry count."
  type        = number
  default     = 2
}

variable "retry_base_delay_ms" {
  description = "Base provider retry backoff."
  type        = number
  default     = 1000
}

variable "retry_max_delay_ms" {
  description = "Maximum provider retry backoff."
  type        = number
  default     = 30000
}

variable "circuit_failure_threshold" {
  description = "Provider circuit breaker failure threshold."
  type        = number
  default     = 3
}

variable "circuit_cooldown_ms" {
  description = "Provider circuit breaker cooldown."
  type        = number
  default     = 60000
}

variable "deepinfra_token_parameter_arn" {
  description = "Exact SSM SecureString ARN for the environment's DeepInfra token."
  type        = string
}

variable "cloudflare_token_parameter_arn" {
  description = "Exact SSM SecureString ARN for the environment's Cloudflare Workers AI token."
  type        = string
}

variable "api_workload_auth_parameter_arn" {
  description = "Exact SSM SecureString ARN for the recorder control API workload credential."
  type        = string
}

variable "ssm_kms_key_arns" {
  description = "Optional exact KMS key ARNs used by those SSM SecureStrings."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 14

  validation {
    condition     = var.log_retention_days >= 1 && var.log_retention_days <= 3653 && floor(var.log_retention_days) == var.log_retention_days
    error_message = "log_retention_days must be an integer from 1 through 3653."
  }
}

variable "log_kms_key_arn" {
  description = "Optional KMS key for the Lambda log group."
  type        = string
  default     = null
  nullable    = true
}

variable "failure_queue_kms_key_arn" {
  description = "Optional KMS key for the async failure destination queue."
  type        = string
  default     = null
  nullable    = true
}

variable "async_max_event_age_seconds" {
  description = "Maximum age of an asynchronous Lambda event before it is sent to the failure destination."
  type        = number
  default     = 3600

  validation {
    condition     = var.async_max_event_age_seconds >= 60 && var.async_max_event_age_seconds <= 21600 && floor(var.async_max_event_age_seconds) == var.async_max_event_age_seconds
    error_message = "async_max_event_age_seconds must be an integer between 60 seconds and 6 hours."
  }
}

variable "async_maximum_retry_attempts" {
  description = "Asynchronous Lambda retry count, bounded by AWS to 0-2 attempts."
  type        = number
  default     = 2

  validation {
    condition     = var.async_maximum_retry_attempts >= 0 && var.async_maximum_retry_attempts <= 2 && floor(var.async_maximum_retry_attempts) == var.async_maximum_retry_attempts
    error_message = "async_maximum_retry_attempts must be 0, 1, or 2."
  }
}

variable "scheduler_name" {
  description = "EventBridge Scheduler schedule name."
  type        = string
  default     = "transcription-reconcile"
}

variable "scheduler_group_name" {
  description = "Existing EventBridge Scheduler group name."
  type        = string
  default     = "default"
}

variable "scheduler_input_json" {
  description = "Bounded JSON wake-up hint delivered by EventBridge Scheduler. It never carries job state."
  type        = string
  default     = "{\"source\":\"eventbridge.scheduler\",\"kind\":\"transcription-reconcile\"}"

  validation {
    condition     = can(jsondecode(var.scheduler_input_json)) && length(var.scheduler_input_json) <= 1048576
    error_message = "scheduler_input_json must be valid JSON and no larger than AWS's 1 MiB async payload limit."
  }
}

variable "scheduler_max_event_age_seconds" {
  description = "Maximum EventBridge Scheduler target invocation age."
  type        = number
  default     = 3600

  validation {
    condition     = var.scheduler_max_event_age_seconds >= 60 && var.scheduler_max_event_age_seconds <= 86400 && floor(var.scheduler_max_event_age_seconds) == var.scheduler_max_event_age_seconds
    error_message = "scheduler_max_event_age_seconds must be an integer between 60 seconds and 24 hours."
  }
}

variable "scheduler_maximum_retry_attempts" {
  description = "EventBridge Scheduler target retry count."
  type        = number
  default     = 2

  validation {
    condition     = var.scheduler_maximum_retry_attempts >= 0 && var.scheduler_maximum_retry_attempts <= 185 && floor(var.scheduler_maximum_retry_attempts) == var.scheduler_maximum_retry_attempts
    error_message = "scheduler_maximum_retry_attempts must be an integer from 0 through 185."
  }
}

variable "alarm_actions" {
  description = "Optional CloudWatch alarm action ARNs supplied by the environment integration."
  type        = list(string)
  default     = []
}

variable "control_api_invoker_principal" {
  description = "Optional principal allowed to send the control-plane asynchronous wake-up."
  type        = string
  default     = null
  nullable    = true
}

variable "control_api_invoke_source_arn" {
  description = "Optional source ARN constraining the control-plane invoke permission."
  type        = string
  default     = null
  nullable    = true
}

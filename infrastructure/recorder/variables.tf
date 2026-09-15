variable "environment" {
  description = "Recorder environment. Only staging and production are deployable."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "enable_apply" {
  description = "Explicit mutation gate. It must remain false for formatting and validation."
  type        = bool
  default     = false
}

variable "staging_evidence_digest" {
  description = "SHA-256 digest of the redacted staging recorder gate evidence."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.staging_evidence_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.staging_evidence_digest))
    error_message = "staging_evidence_digest must be sha256:<64 lowercase hexadecimal characters>."
  }
}

variable "capture_provider_token" {
  description = "Short-lived DigitalOcean token scoped to capture Droplet, firewall, tag, image, action, and inventory operations."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "render_provider_token" {
  description = "Short-lived DigitalOcean token scoped to render Droplet, firewall, tag, image, action, and inventory operations."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token scoped to the environment recording bucket only."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account identifier supplied through private environment configuration."
  type        = string
  default     = null
  nullable    = true
}

variable "recording_bucket_name" {
  description = "Private environment recording bucket name; existing production buckets are adopted only after an approved inventory."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.recording_bucket_name == null || can(regex("^[a-z0-9][a-z0-9-]{2,62}$", var.recording_bucket_name))
    error_message = "recording_bucket_name must be a lowercase R2-compatible name."
  }
}

variable "recording_bucket_import_id" {
  description = "Private inventory import ID for an existing recording bucket. Production adoption requires this value and an approved no-delete plan."
  type        = string
  default     = null
  nullable    = true
}

variable "recording_bucket_adoption_plan_digest" {
  description = "SHA-256 digest of the read-only production bucket inventory and no-delete/no-replacement plan."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.recording_bucket_adoption_plan_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.recording_bucket_adoption_plan_digest))
    error_message = "recording_bucket_adoption_plan_digest must be sha256:<64 lowercase hexadecimal characters>."
  }
}

variable "whiteboard_allowed_origins" {
  description = "Exact browser origins allowed to use whiteboard-v1 presigned GET and PUT URLs."
  type        = list(string)
  default     = []

  validation {
    condition = length(var.whiteboard_allowed_origins) <= 8 && alltrue([
      for origin in var.whiteboard_allowed_origins :
      origin != "*" && can(regex("^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$", origin))
    ])
    error_message = "whiteboard_allowed_origins must contain at most eight exact HTTP(S) origins without paths, trailing slashes, or wildcards."
  }
}

variable "temporary_bundle_prefix" {
  description = "Compatibility input for the fixed temporary/ prefix containing encrypted capture bundles and wrapped-key metadata."
  type        = string
  default     = "temporary/"

  validation {
    condition     = var.temporary_bundle_prefix == "temporary/"
    error_message = "temporary_bundle_prefix is a fixed storage contract and must equal 'temporary/'."
  }
}

variable "kms_region" {
  description = "AWS region for the environment recording KEK."
  type        = string
  default     = "ap-southeast-1"

  validation {
    condition     = var.kms_region == "ap-southeast-1"
    error_message = "recording KEKs must remain in AWS Singapore (ap-southeast-1)."
  }
}

variable "control_plane_role_arn" {
  description = "Only role allowed to generate and decrypt recording data keys."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.control_plane_role_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.control_plane_role_arn))
    error_message = "control_plane_role_arn must be a valid IAM role ARN."
  }
}

variable "legacy_kms_context_key" {
  description = "Optional externally supplied legacy KMS context key for the bounded production ciphertext-decrypt transition; it never authorizes new data-key generation."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.legacy_kms_context_key == null || (
      can(regex("^chalk\\.[a-z][a-z0-9_]{1,63}$", var.legacy_kms_context_key)) && !contains([
        "chalk.environment",
        "chalk.tenant",
        "chalk.episode",
        "chalk.recording",
        "chalk.recording_job",
        "chalk.bundle_schema",
        "chalk.capture_epoch",
        "chalk.envelope_digest",
      ], var.legacy_kms_context_key)
    )
    error_message = "legacy_kms_context_key must be a distinct non-canonical chalk.<identifier> context key."
  }
}

variable "episode_kms_context_cutover_complete" {
  description = "Explicit production acknowledgment that every data-key producer emits the canonical Episode context and no legacy ciphertext still requires access."
  type        = bool
  default     = false
}

variable "capture_image_id" {
  description = "Immutable DigitalOcean image ID for the capture pool."
  type        = number
  default     = 0
  validation {
    condition     = var.capture_image_id >= 0 && floor(var.capture_image_id) == var.capture_image_id
    error_message = "capture_image_id must be a non-negative integer image ID."
  }
}

variable "capture_image_digest" {
  description = "SHA-256 digest of the installed recorder image manifest for the capture pool."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.capture_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.capture_image_digest))
    error_message = "capture_image_digest must be sha256:<64 lowercase hexadecimal characters>."
  }
}

variable "render_image_id" {
  description = "Immutable DigitalOcean image ID for the render pool."
  type        = number
  default     = 0
  validation {
    condition     = var.render_image_id >= 0 && floor(var.render_image_id) == var.render_image_id
    error_message = "render_image_id must be a non-negative integer image ID."
  }
}

variable "render_image_digest" {
  description = "SHA-256 digest of the installed recorder image manifest for the render pool."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.render_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.render_image_digest))
    error_message = "render_image_digest must be sha256:<64 lowercase hexadecimal characters>."
  }
}

variable "release_id" {
  description = "Immutable release identifier recorded on every node."
  type        = string
  default     = "validation-only"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{0,127}$", var.release_id))
    error_message = "release_id must be a bounded lowercase release identifier."
  }
}

variable "capture_bootstrap_endpoint" {
  description = "External control-plane endpoint that consumes one-time bootstrap assertions."
  type        = string
  default     = null
  nullable    = true
}

variable "render_bootstrap_endpoint" {
  description = "External control-plane endpoint that consumes one-time bootstrap assertions."
  type        = string
  default     = null
  nullable    = true
}

variable "reserved_capture_episodes" {
  description = "Reserved or active capture Episodes used by the desired-capacity formula."
  type        = number
  default     = 0
}

variable "reserved_capture_participants" {
  description = "Reserved or active capture participants used by the desired-capacity formula."
  type        = number
  default     = 0
}

variable "reserved_capture_input_mbps" {
  description = "Reserved or active capture input bitrate used by the desired-capacity formula."
  type        = number
  default     = 0
}

variable "ready_spare" {
  description = "Cost-first recorder profile has no idle or implicit capture spare."
  type        = number
  default     = 0

  validation {
    condition     = var.ready_spare == 0
    error_message = "ready_spare must be zero for this profile."
  }
}

variable "capture_episodes_per_node" {
  description = "Qualified serial capture density for a two-vCPU node."
  type        = number
  default     = 1
}

variable "capture_capacity_inputs_migrated" {
  description = "Explicit production acknowledgment that callers and private tfvars use the renamed Episode capacity inputs."
  type        = bool
  default     = false
}

variable "capture_participants_per_node" {
  description = "Qualified participant density for a two-vCPU node."
  type        = number
  default     = 40
}

variable "capture_input_mbps_per_node" {
  description = "Qualified capture bitrate density for a two-vCPU node."
  type        = number
  default     = 16
}

variable "render_desired_nodes" {
  description = "Render nodes requested by the external deadline-aware scaler."
  type        = number
  default     = 0

  validation {
    condition     = var.render_desired_nodes >= 0 && var.render_desired_nodes <= 10 && floor(var.render_desired_nodes) == var.render_desired_nodes
    error_message = "render_desired_nodes must be an integer between zero and ten."
  }
}

variable "capture_node_size" {
  description = "Capture profile: c-2 is the prior baseline; smaller shared-CPU candidates require exact-profile cloud qualification evidence before apply."
  type        = string
  default     = "c-2"

  validation {
    condition     = contains(["s-1vcpu-1gb", "s-1vcpu-2gb", "c-2"], var.capture_node_size)
    error_message = "Select a candidate from the bounded capture qualification profile."
  }
}

variable "capture_profile_evidence_sha256" {
  description = "Redacted one-hour qualification evidence for the exact smaller capture size, region, and sealed image; absence keeps candidates disabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.capture_profile_evidence_sha256 == null || can(regex("^[0-9a-f]{64}$", var.capture_profile_evidence_sha256))
    error_message = "Capture qualification evidence must be a SHA-256 digest."
  }
}

variable "render_node_size" {
  description = "DigitalOcean renderer size. The default is the measured eight-vCPU CPU renderer; a GPU image must override this together with render_region and render_gpu."
  type        = string
  default     = "c-8"
}

variable "render_region" {
  description = "DigitalOcean renderer region. NYC1 is the measured CPU renderer region."
  type        = string
  default     = "nyc1"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,31}$", var.render_region))
    error_message = "render_region must be a DigitalOcean region slug."
  }
}

variable "render_gpu" {
  description = "Whether the render pool uses DigitalOcean GPU inventory. Keep false for the c-8/libx264 image; set true only with a separately qualified GPU image, region, and size."
  type        = bool
  default     = false
}

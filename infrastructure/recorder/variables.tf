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

variable "temporary_bundle_prefix" {
  description = "Prefix containing encrypted temporary capture bundles and wrapped-key metadata."
  type        = string
  default     = "temporary/"

  validation {
    condition     = length(var.temporary_bundle_prefix) > 0 && endswith(var.temporary_bundle_prefix, "/")
    error_message = "temporary_bundle_prefix must be a non-empty prefix ending in '/'."
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
  description = "OCI digest attested for the capture image."
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
  description = "OCI digest attested for the render image."
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

variable "reserved_capture_meetings" {
  description = "Reserved or active capture meetings used by the desired-capacity formula."
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
  description = "One ready spare while capture work is reserved or active, otherwise zero."
  type        = number
  default     = 0

  validation {
    condition     = var.ready_spare >= 0 && var.ready_spare <= 1 && floor(var.ready_spare) == var.ready_spare
    error_message = "ready_spare must be 0 or 1."
  }
}

variable "capture_meetings_per_node" {
  description = "Qualified capture density for a two-vCPU node."
  type        = number
  default     = 4
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
  description = "DigitalOcean SGP1 CPU-Optimized 2-vCPU/4-GiB size selected after staging qualification."
  type        = string
  default     = "c-2"
}

variable "render_node_size" {
  description = "DigitalOcean TOR1 RTX 4000 GPU size selected after staging qualification."
  type        = string
  default     = "gpu-4000-20gb"
}

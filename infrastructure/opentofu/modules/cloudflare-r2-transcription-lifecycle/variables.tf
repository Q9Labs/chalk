variable "account_id" {
  description = "Cloudflare account ID owning the existing R2 bucket."
  type        = string

  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase Cloudflare account ID."
  }
}

variable "bucket_name" {
  description = "Existing private R2 bucket name. This module never creates or deletes the bucket."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid R2 bucket name."
  }
}

variable "temporary_prefixes" {
  description = "Prefixes containing temporary transcription chunks and orphan objects; finalized transcript prefixes are excluded."
  type        = list(string)
  default     = ["transcription/chunks/", "transcription/orphans/"]

  validation {
    condition     = length(var.temporary_prefixes) > 0 && alltrue([for prefix in var.temporary_prefixes : length(prefix) > 0 && !startswith(prefix, "/")])
    error_message = "temporary_prefixes must contain non-empty relative prefixes."
  }
}

variable "temporary_expiration_hours" {
  description = "Orphan/temporary transcription object expiration; launch contract is 24 hours."
  type        = number
  default     = 24

  validation {
    condition     = var.temporary_expiration_hours == 24
    error_message = "temporary_expiration_hours is fixed at 24 hours by the transcription lifecycle contract."
  }
}

variable "committed_cleanup_deadline_hours" {
  description = "Application-owned committed-object deletion deadline; lifecycle is not authoritative for finalized transcripts."
  type        = number
  default     = 1

  validation {
    condition     = var.committed_cleanup_deadline_hours > 0 && var.committed_cleanup_deadline_hours <= 1
    error_message = "committed_cleanup_deadline_hours must be no more than one hour."
  }
}

variable "finalized_transcript_prefix" {
  description = "Reserved finalized transcript prefix that no lifecycle rule may cover."
  type        = string
  default     = "transcription/finalized/"
}

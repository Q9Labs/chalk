locals {
  # A production bucket name is never guessed: omission must stop before the
  # provider can propose creating a replacement bucket.
  bucket_name = var.recording_bucket_name != null ? var.recording_bucket_name : (var.environment == "staging" ? "chalk-recorder-staging" : "")

  capture_meeting_nodes      = var.reserved_capture_meetings == 0 ? 0 : ceil(var.reserved_capture_meetings / var.capture_meetings_per_node)
  capture_participant_nodes  = var.reserved_capture_participants == 0 ? 0 : ceil(var.reserved_capture_participants / var.capture_participants_per_node)
  capture_bitrate_nodes      = var.reserved_capture_input_mbps == 0 ? 0 : ceil(var.reserved_capture_input_mbps / var.capture_input_mbps_per_node)
  desired_capture_nodes_raw  = max(local.capture_meeting_nodes, local.capture_participant_nodes, local.capture_bitrate_nodes) + var.ready_spare
  desired_capture_nodes      = min(local.desired_capture_nodes_raw, 11)
  desired_render_nodes       = var.render_desired_nodes
  global_compute_nodes       = local.desired_capture_nodes + local.desired_render_nodes
  control_plane_role         = coalesce(var.control_plane_role_arn, "")
  capture_image_digest       = coalesce(var.capture_image_digest, "")
  render_image_digest        = coalesce(var.render_image_digest, "")
  capture_bootstrap_endpoint = coalesce(var.capture_bootstrap_endpoint, "")
  render_bootstrap_endpoint  = coalesce(var.render_bootstrap_endpoint, "")
}

check "capture_admission_ceiling" {
  assert {
    condition     = var.reserved_capture_meetings >= 0 && var.reserved_capture_meetings <= 20 && floor(var.reserved_capture_meetings) == var.reserved_capture_meetings
    error_message = "capture reservations must contain an integer number of meetings from zero through twenty."
  }

  assert {
    condition     = var.reserved_capture_participants >= 0 && var.reserved_capture_participants <= 100 && floor(var.reserved_capture_participants) == var.reserved_capture_participants
    error_message = "capture reservations must contain an integer participant count from zero through one hundred."
  }

  assert {
    condition     = var.reserved_capture_input_mbps >= 0 && var.reserved_capture_input_mbps <= 80
    error_message = "capture reservations must stay within the qualified 80 Mbps launch input ceiling."
  }

  assert {
    condition     = var.capture_meetings_per_node > 0 && var.capture_participants_per_node > 0 && var.capture_input_mbps_per_node > 0
    error_message = "capture density inputs must be positive."
  }

  assert {
    condition     = local.desired_capture_nodes_raw <= 11
    error_message = "capture demand requires more than the eleven-node qualified bound; production admission must close."
  }

  assert {
    condition     = local.global_compute_nodes <= 21
    error_message = "capture and render demand exceeds the twenty-one-node global recorder compute cap."
  }
}

check "production_bucket_adoption_contract" {
  assert {
    condition     = var.environment == "staging" || (var.recording_bucket_name != null && var.recording_bucket_import_id != null && var.recording_bucket_adoption_plan_digest != null)
    error_message = "production requires an explicit existing R2 bucket name, inventory import ID, and no-delete adoption-plan digest before planning."
  }
}

resource "terraform_data" "apply_gate" {
  count = var.enable_apply ? 1 : 0

  input = {
    environment                = var.environment
    release_id                 = var.release_id
    staging_evidence_digest    = var.staging_evidence_digest
    desired_capture_nodes      = local.desired_capture_nodes
    desired_render_nodes       = local.desired_render_nodes
    global_recorder_node_count = local.global_compute_nodes
  }

  lifecycle {
    precondition {
      condition     = can(regex("^sha256:[0-9a-f]{64}$", coalesce(var.staging_evidence_digest, "")))
      error_message = "recorder mutation is disabled until a redacted staging evidence digest is supplied."
    }

    precondition {
      condition     = var.capture_provider_token != null && length(trimspace(var.capture_provider_token)) > 0 && var.render_provider_token != null && length(trimspace(var.render_provider_token)) > 0
      error_message = "recorder mutation requires separate short-lived capture and render DigitalOcean tokens."
    }

    precondition {
      condition     = var.cloudflare_api_token != null && length(trimspace(var.cloudflare_api_token)) > 0 && var.cloudflare_account_id != null && length(trimspace(var.cloudflare_account_id)) > 0
      error_message = "recorder mutation requires a scoped Cloudflare token and account identifier."
    }

    precondition {
      condition     = var.control_plane_role_arn != null && length(trimspace(var.control_plane_role_arn)) > 0
      error_message = "recorder mutation requires the control-plane IAM role ARN for KMS key policy."
    }

    precondition {
      condition     = var.capture_image_digest != null && var.render_image_digest != null && var.capture_bootstrap_endpoint != null && var.render_bootstrap_endpoint != null
      error_message = "recorder mutation requires both attested image digests and external one-time bootstrap endpoints."
    }

    precondition {
      condition     = var.environment == "staging" || (var.recording_bucket_name != null && var.recording_bucket_import_id != null && var.recording_bucket_adoption_plan_digest != null)
      error_message = "production recorder mutation requires an explicit existing bucket name, private inventory import ID, and approved no-delete adoption-plan digest."
    }
  }
}

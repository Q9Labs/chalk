terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

locals {
  name = "${var.project}-${var.environment}"

  tags = {
    Environment = var.environment
    Module      = "cloudflare"
    Project     = var.project
  }
}

# Cloudflare Realtime SFU App - WebRTC infrastructure
resource "cloudflare_calls_sfu_app" "main" {
  count      = var.enabled && var.enable_calls ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "${local.name}-sfu"
}

# Cloudflare Realtime TURN App - NAT traversal for WebRTC
resource "cloudflare_calls_turn_app" "main" {
  count      = var.enabled && var.enable_calls ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "${local.name}-turn"
}

# R2 Bucket - Hot storage for recordings (0-7 days)
resource "cloudflare_r2_bucket" "recordings" {
  count         = var.enabled ? 1 : 0
  account_id    = var.cloudflare_account_id
  name          = "${local.name}-recordings"
  location      = var.r2_location
  storage_class = "Standard"
}

# R2 Lifecycle - Auto-transition to InfrequentAccess after 7 days
resource "cloudflare_r2_bucket_lifecycle" "recordings" {
  count       = var.enabled ? 1 : 0
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.recordings[0].name

  # Lifecycle rules can't be destroyed via API, only manually
  lifecycle {
    prevent_destroy = true
  }

  rules = [
    {
      id      = "archive-after-7-days"
      enabled = true
      conditions = {
        prefix = ""
      }
      storage_class_transitions = [{
        condition = {
          max_age = 604800 # 7 days in seconds
          type    = "Age"
        }
        storage_class = "InfrequentAccess"
      }]
    },
    {
      id      = "delete-after-retention"
      enabled = var.recording_retention_days > 0
      conditions = {
        prefix = ""
      }
      delete_objects_transition = {
        condition = {
          max_age = var.recording_retention_days * 86400 # days to seconds
          type    = "Age"
        }
      }
    }
  ]
}

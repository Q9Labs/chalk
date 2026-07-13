module "capture" {
  source = "./modules/digitalocean-recorder-capture"

  providers = {
    digitalocean = digitalocean.capture
  }

  environment        = var.environment
  desired_nodes      = local.desired_capture_nodes
  node_size          = var.capture_node_size
  image_id           = var.capture_image_id
  image_digest       = local.capture_image_digest
  release_id         = var.release_id
  bootstrap_endpoint = local.capture_bootstrap_endpoint
  enable_apply       = var.enable_apply
}

module "render" {
  source = "./modules/digitalocean-recorder-render"

  providers = {
    digitalocean = digitalocean.render
  }

  environment        = var.environment
  desired_nodes      = local.desired_render_nodes
  node_size          = var.render_node_size
  image_id           = var.render_image_id
  image_digest       = local.render_image_digest
  release_id         = var.release_id
  bootstrap_endpoint = local.render_bootstrap_endpoint
  enable_apply       = var.enable_apply
}

data "aws_iam_policy_document" "recording_kms" {
  count    = var.enable_apply ? 1 : 0
  provider = aws.recording

  statement {
    sid    = "KeyAdministratorsWithoutDataAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current[0].account_id}:root"]
    }

    actions = [
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:CreateGrant",
      "kms:Describe*",
      "kms:DisableKey",
      "kms:EnableKey",
      "kms:Get*",
      "kms:List*",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
      "kms:UpdateKeyDescription",
    ]

    resources = ["*"]
  }

  statement {
    sid    = "ControlPlaneGenerateAndDecryptRecordingKeys"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [local.control_plane_role]
    }

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
    ]

    resources = ["*"]

    # Every data-key operation must carry the same authenticated context. The
    # control plane supplies tenant/session/job values at runtime; their
    # presence is required here without ever putting those values in state.
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:chalk.environment"
      values   = [var.environment]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values = [
        "chalk.environment",
        "chalk.tenant",
        "chalk.session",
        "chalk.recording_job",
        "chalk.bundle_schema",
      ]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:chalk.environment"
      values   = ["false"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:chalk.tenant"
      values   = ["false"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:chalk.session"
      values   = ["false"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:chalk.recording_job"
      values   = ["false"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:chalk.bundle_schema"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyRecordingDataOperationsOutsideControlPlane"
    effect = "Deny"

    not_principals {
      type        = "AWS"
      identifiers = [local.control_plane_role]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]

    resources = ["*"]
  }
}

resource "aws_kms_key" "recording" {
  count                   = var.enable_apply ? 1 : 0
  provider                = aws.recording
  description             = "Chalk ${var.environment} recorder bundle KEK"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.recording_kms[0].json

  tags = {
    chalk_environment = var.environment
    chalk_purpose     = "recorder-bundle-envelope-encryption"
    chalk_release     = var.release_id
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "recording" {
  count         = var.enable_apply ? 1 : 0
  provider      = aws.recording
  name          = "alias/chalk-recorder-${var.environment}"
  target_key_id = aws_kms_key.recording[0].key_id
}

resource "cloudflare_r2_bucket" "recording" {
  count      = var.enable_apply ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = local.bucket_name
  location   = "apac"

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.environment == "staging" || (var.recording_bucket_name != null && var.recording_bucket_import_id != null)
      error_message = "production R2 adoption is fail-closed: import the explicitly named existing bucket before any apply."
    }
  }
}

resource "cloudflare_r2_bucket_lifecycle" "recording" {
  count       = var.enable_apply ? 1 : 0
  account_id  = var.cloudflare_account_id
  bucket_name = local.bucket_name

  rules = [
    {
      id         = "encrypted-temporary-bundles-expire"
      enabled    = true
      conditions = { prefix = var.temporary_bundle_prefix }
      delete_objects_transition = {
        condition = {
          max_age = 86400
          type    = "Age"
        }
      }
    },
    {
      id         = "incomplete-multipart-expire"
      enabled    = true
      conditions = { prefix = "" }
      abort_multipart_uploads_transition = {
        condition = {
          max_age = 604800
          type    = "Age"
        }
      }
    },
  ]
}

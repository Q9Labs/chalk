data "aws_caller_identity" "current" {}
data "aws_elb_service_account" "main" {}

locals {
  alb_access_logs_bucket_name = "${local.name}-alb-logs-${data.aws_caller_identity.current.account_id}"
  alb_access_logs_prefix      = trim(var.alb_access_logs_prefix, "/")
}

resource "aws_s3_bucket" "alb_access_logs" {
  count = var.enable_alb_access_logs ? 1 : 0

  bucket        = local.alb_access_logs_bucket_name
  force_destroy = var.environment != "prod"

  tags = local.tags
}

resource "aws_s3_bucket_public_access_block" "alb_access_logs" {
  count = var.enable_alb_access_logs ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_access_logs" {
  count = var.enable_alb_access_logs ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_access_logs" {
  count = var.enable_alb_access_logs ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_access_logs" {
  count = var.enable_alb_access_logs ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  rule {
    id     = "expire"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = var.alb_access_logs_retention_days
    }
  }
}

resource "aws_s3_bucket_policy" "alb_access_logs" {
  count = var.enable_alb_access_logs ? 1 : 0

  bucket = aws_s3_bucket.alb_access_logs[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AWSLogDeliveryAclCheck"
        Effect = "Allow"
        Principal = {
          AWS = data.aws_elb_service_account.main.arn
        }
        Action   = "s3:GetBucketAcl"
        Resource = aws_s3_bucket.alb_access_logs[0].arn
      },
      {
        Sid    = "AWSLogDeliveryWrite"
        Effect = "Allow"
        Principal = {
          AWS = data.aws_elb_service_account.main.arn
        }
        Action   = "s3:PutObject"
        Resource = local.alb_access_logs_prefix != "" ? "${aws_s3_bucket.alb_access_logs[0].arn}/${local.alb_access_logs_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/*" : "${aws_s3_bucket.alb_access_logs[0].arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
          }
        }
      }
    ]
  })
}

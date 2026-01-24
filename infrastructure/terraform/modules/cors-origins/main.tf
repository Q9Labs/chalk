terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

locals {
  name = "chalk-cors-origins-${var.environment}"

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "cors-origins"
  })
}

# S3 bucket for storing aggregated CORS origins
resource "aws_s3_bucket" "cors_origins" {
  bucket = local.name

  tags = local.tags
}

resource "aws_s3_bucket_versioning" "cors_origins" {
  bucket = aws_s3_bucket.cors_origins.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cors_origins" {
  bucket = aws_s3_bucket.cors_origins.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cors_origins" {
  bucket = aws_s3_bucket.cors_origins.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# IAM policy for API to write to this bucket
resource "aws_iam_policy" "cors_origins_write" {
  name        = "${local.name}-write"
  description = "Allow writing CORS origins to S3"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.cors_origins.arn,
          "${aws_s3_bucket.cors_origins.arn}/*"
        ]
      }
    ]
  })

  tags = local.tags
}

# Seed the bucket with initial origins file
resource "aws_s3_object" "initial_origins" {
  bucket       = aws_s3_bucket.cors_origins.id
  key          = var.origins_key
  content_type = "application/json"

  content = jsonencode({
    origins = var.static_origins
    updated_at = timestamp()
  })

  # Only create if object doesn't exist (don't overwrite API updates)
  lifecycle {
    ignore_changes = [content, etag]
  }

  tags = local.tags
}

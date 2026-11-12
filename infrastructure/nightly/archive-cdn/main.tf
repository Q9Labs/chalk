terraform {
  required_version = "= 1.12.3"
  backend "s3" {
    key          = "archive-cdn/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.90.0"
    }
  }
}

provider "aws" {
  region = "ap-southeast-1"
}

variable "public_key_pem" {
  type        = string
  description = "RSA public key (PEM) whose private half the recorder fleet controller uses to sign archive links."
}

data "aws_caller_identity" "current" {}

locals {
  bucket = "chalk-nightly-artifacts-${data.aws_caller_identity.current.account_id}"
  tags = {
    "chalk:environment" = "nightly"
    "chalk:purpose"     = "recorder-archive-cdn"
  }
}

data "aws_s3_bucket" "artifacts" {
  bucket = local.bucket
}

# Recorder droplets download ~290 MB archives from the internet after every release.
# From S3 that is data transfer out (USD 0.12 per GB); from CloudFront the first 1 TB a month is free and the S3 origin fetch costs nothing.
resource "aws_cloudfront_origin_access_control" "archive" {
  name                              = "chalk-recorder-archive"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_public_key" "archive" {
  name        = "chalk-recorder-archive"
  encoded_key = var.public_key_pem
}

resource "aws_cloudfront_key_group" "archive" {
  name  = "chalk-recorder-archive"
  items = [aws_cloudfront_public_key.archive.id]
}

resource "aws_cloudfront_distribution" "archive" {
  enabled         = true
  comment         = "Chalk recorder archives (signed links only)"
  http_version    = "http2"
  is_ipv6_enabled = true
  price_class     = "PriceClass_All"
  tags            = local.tags

  origin {
    domain_name              = data.aws_s3_bucket.artifacts.bucket_regional_domain_name
    origin_id                = "artifacts"
    origin_access_control_id = aws_cloudfront_origin_access_control.archive.id
  }

  default_cache_behavior {
    target_origin_id       = "artifacts"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false
    trusted_key_groups     = [aws_cloudfront_key_group.archive.id]
    # Managed CachingOptimized: signature query parameters stay out of the cache key, so every boot after the first hits the edge.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# The bucket policy is not managed anywhere else; keep its existing TLS-only statement.
resource "aws_s3_bucket_policy" "artifacts" {
  bucket = data.aws_s3_bucket.artifacts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [data.aws_s3_bucket.artifacts.arn, "${data.aws_s3_bucket.artifacts.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "AllowRecorderArchiveCloudFront"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${data.aws_s3_bucket.artifacts.arn}/recorder/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.archive.arn } }
      },
    ]
  })
}

output "distribution_url" {
  value = "https://${aws_cloudfront_distribution.archive.domain_name}"
}

output "key_pair_id" {
  value = aws_cloudfront_public_key.archive.id
}

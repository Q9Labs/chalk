terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  name = "chalk-${var.environment}"

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "secrets"
  })
}

resource "aws_kms_key" "secrets" {
  description             = "KMS key for Chalk secrets"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(local.tags, {
    Name = "${local.name}-secrets-kms"
  })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "random_password" "jwt_secret" {
  length  = 64
  special = true
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name        = "chalk/${var.environment}/jwt-secret"
  description = "JWT signing secret for Chalk API"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt_secret.result
}

resource "aws_secretsmanager_secret" "cloudflare_api" {
  name        = "chalk/${var.environment}/cloudflare"
  description = "Cloudflare RealtimeKit API credentials"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "cloudflare_api" {
  secret_id = aws_secretsmanager_secret.cloudflare_api.id
  secret_string = jsonencode({
    sfu_app_id     = var.cloudflare_app_id
    sfu_app_secret = var.cloudflare_app_secret
    turn_app_id    = var.turn_app_id
    turn_app_key   = var.turn_app_key
  })
}

resource "aws_secretsmanager_secret" "api_config" {
  name        = "chalk/${var.environment}/api-config"
  description = "API configuration secrets"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "api_config" {
  secret_id = aws_secretsmanager_secret.api_config.id
  secret_string = jsonencode({
    jwt_secret       = random_password.jwt_secret.result
    jwt_expiry_hours = var.jwt_expiry_hours
    api_key_salt     = random_password.api_key_salt.result
  })
}

resource "random_password" "api_key_salt" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "github_token" {
  name        = "chalk/${var.environment}/github-token"
  description = "GitHub PAT for What's New releases API"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret" "r2_credentials" {
  name        = "chalk/${var.environment}/r2-credentials"
  description = "Cloudflare R2 storage credentials"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "r2_credentials" {
  secret_id = aws_secretsmanager_secret.r2_credentials.id
  secret_string = jsonencode({
    access_key_id     = var.r2_access_key_id
    secret_access_key = var.r2_secret_access_key
  })
}

resource "aws_secretsmanager_secret" "axiom" {
  name        = "chalk/${var.environment}/axiom"
  description = "Axiom logging credentials"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "axiom" {
  secret_id = aws_secretsmanager_secret.axiom.id
  secret_string = jsonencode({
    token   = var.axiom_token
    dataset = var.axiom_dataset
  })
}

# =============================================================================
# Post-Meeting Transcription & AI Secrets
# =============================================================================

resource "aws_secretsmanager_secret" "groq_api" {
  name        = "chalk/${var.environment}/groq"
  description = "Groq API key for transcription"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "groq_api" {
  count         = var.groq_api_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.groq_api.id
  secret_string = var.groq_api_key
}

resource "aws_secretsmanager_secret" "openrouter_api" {
  name        = "chalk/${var.environment}/openrouter"
  description = "OpenRouter API key for AI summaries"
  kms_key_id  = aws_kms_key.secrets.arn

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "openrouter_api" {
  count         = var.openrouter_api_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.openrouter_api.id
  secret_string = var.openrouter_api_key
}

resource "aws_iam_policy" "secrets_read" {
  name        = "${local.name}-secrets-read"
  description = "Policy to read Chalk secrets"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = [
          aws_secretsmanager_secret.jwt_secret.arn,
          aws_secretsmanager_secret.cloudflare_api.arn,
          aws_secretsmanager_secret.api_config.arn,
          aws_secretsmanager_secret.github_token.arn,
          aws_secretsmanager_secret.r2_credentials.arn,
          aws_secretsmanager_secret.axiom.arn,
          aws_secretsmanager_secret.groq_api.arn,
          aws_secretsmanager_secret.openrouter_api.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = [
          aws_kms_key.secrets.arn
        ]
      }
    ]
  })

  tags = local.tags
}

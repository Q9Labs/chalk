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
    Module      = "elasticache"
  })
}

data "aws_region" "current" {}

resource "aws_elasticache_subnet_group" "redis" {
  name        = "${local.name}-redis"
  description = "Subnet group for Redis"
  subnet_ids  = var.subnet_ids

  tags = merge(local.tags, {
    Name = "${local.name}-redis-subnet-group"
  })
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis-sg"
  description = "Security group for ElastiCache Redis"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis from ECS"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, {
    Name = "${local.name}-redis-sg"
  })
}

resource "aws_kms_key" "redis" {
  count = var.create_kms_key ? 1 : 0

  description             = "KMS key for Redis encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(local.tags, {
    Name = "${local.name}-redis-kms"
  })
}

resource "aws_kms_alias" "redis" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${local.name}-redis"
  target_key_id = aws_kms_key.redis[0].key_id
}

resource "random_password" "redis_auth" {
  count = var.auth_token == null ? 1 : 0

  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "redis_auth" {
  count = var.auth_token == null ? 1 : 0

  name        = "chalk/${var.environment}/redis-auth-token"
  description = "Redis AUTH token"

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  count = var.auth_token == null ? 1 : 0

  secret_id     = aws_secretsmanager_secret.redis_auth[0].id
  secret_string = random_password.redis_auth[0].result
}

resource "aws_elasticache_parameter_group" "redis" {
  family      = "redis7"
  name        = "${local.name}-redis-params"
  description = "Custom parameter group optimized for WebSocket pub/sub"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  parameter {
    name  = "timeout"
    value = "300"
  }

  parameter {
    name  = "tcp-keepalive"
    value = "60"
  }

  parameter {
    name  = "notify-keyspace-events"
    value = "Kx"
  }

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "redis_slow" {
  name              = "/aws/elasticache/${local.name}-redis/slow-log"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "redis_engine" {
  name              = "/aws/elasticache/${local.name}-redis/engine-log"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name}-redis"
  description          = "Redis cluster for Chalk ${var.environment}"

  engine               = "redis"
  engine_version       = var.engine_version
  node_type            = var.node_type
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.redis.name

  automatic_failover_enabled = var.multi_az_enabled
  multi_az_enabled           = var.multi_az_enabled
  num_cache_clusters         = var.num_cache_clusters

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = var.create_kms_key ? aws_kms_key.redis[0].arn : var.kms_key_id
  auth_token                 = var.auth_token != null ? var.auth_token : random_password.redis_auth[0].result

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = var.snapshot_window
  maintenance_window       = var.maintenance_window

  auto_minor_version_upgrade = true
  apply_immediately          = var.environment != "prod"

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_engine.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
  }

  tags = local.tags
}

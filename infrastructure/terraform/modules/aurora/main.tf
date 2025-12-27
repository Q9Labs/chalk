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
    Module      = "aurora"
  })
}

data "aws_region" "current" {}

resource "aws_db_subnet_group" "aurora" {
  name        = "${local.name}-aurora"
  description = "Subnet group for Aurora Serverless v2"
  subnet_ids  = var.subnet_ids

  tags = merge(local.tags, {
    Name = "${local.name}-aurora-subnet-group"
  })
}

resource "aws_security_group" "aurora" {
  name        = "${local.name}-aurora-sg"
  description = "Security group for Aurora Serverless v2"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from ECS"
    from_port       = 5432
    to_port         = 5432
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
    Name = "${local.name}-aurora-sg"
  })
}

resource "aws_kms_key" "aurora" {
  count = var.create_kms_key ? 1 : 0

  description             = "KMS key for Aurora encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(local.tags, {
    Name = "${local.name}-aurora-kms"
  })
}

resource "aws_kms_alias" "aurora" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${local.name}-aurora"
  target_key_id = aws_kms_key.aurora[0].key_id
}

resource "aws_iam_role" "rds_enhanced_monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0

  name = "${local.name}-rds-monitoring-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0

  role       = aws_iam_role.rds_enhanced_monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier = "${local.name}-aurora"
  engine             = "aurora-postgresql"
  engine_version     = var.engine_version
  database_name      = var.database_name
  master_username    = var.master_username

  manage_master_user_password = true

  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }

  db_subnet_group_name   = aws_db_subnet_group.aurora.name
  vpc_security_group_ids = [aws_security_group.aurora.id]

  storage_encrypted = true
  kms_key_id        = var.create_kms_key ? aws_kms_key.aurora[0].arn : var.kms_key_id

  backup_retention_period      = var.backup_retention_period
  preferred_backup_window      = var.backup_window
  preferred_maintenance_window = var.maintenance_window
  copy_tags_to_snapshot        = true
  deletion_protection          = var.deletion_protection

  enabled_cloudwatch_logs_exports = ["postgresql"]

  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${local.name}-final-snapshot" : null

  tags = local.tags
}

resource "aws_rds_cluster_instance" "aurora" {
  count = var.instance_count

  identifier         = "${local.name}-aurora-${count.index + 1}"
  cluster_identifier = aws_rds_cluster.aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version

  publicly_accessible = false

  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_retention_period = var.performance_insights_retention_period
  performance_insights_kms_key_id       = var.create_kms_key ? aws_kms_key.aurora[0].arn : var.kms_key_id

  monitoring_interval = var.monitoring_interval
  monitoring_role_arn = var.monitoring_interval > 0 ? aws_iam_role.rds_enhanced_monitoring[0].arn : null

  tags = merge(local.tags, {
    Name = "${local.name}-aurora-${count.index + 1}"
  })
}

resource "aws_cloudwatch_log_group" "aurora" {
  name              = "/aws/rds/cluster/${local.name}-aurora/postgresql"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

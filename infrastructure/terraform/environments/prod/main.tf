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
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  backend "s3" {
    bucket         = "chalk-terraform-state-688819141892"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "chalk-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = local.environment
      Project     = "chalk"
      ManagedBy   = "terraform"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  environment = "prod"
}

module "vpc" {
  source = "../../modules/vpc"

  environment        = local.environment
  cidr_block         = "10.2.0.0/16"
  availability_zones = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]

  enable_nat_gateway   = true
  single_nat_gateway   = false
  enable_vpc_endpoints = true
  enable_flow_logs     = true

  flow_logs_retention_days = 90
}

module "ecr" {
  source = "../../modules/ecr"

  environment          = local.environment
  image_tag_mutability = "IMMUTABLE"
  image_count_to_keep  = 50
}

module "ecs" {
  source = "../../modules/ecs"

  environment        = local.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids

  instance_type    = "t3.large"
  min_capacity     = 3
  max_capacity     = 10
  desired_capacity = 3

  internal_alb          = true
  enable_https_listener = true
  certificate_arn       = module.dns.certificate_validated_arn
  log_retention_days    = 90

  # ECS Service configuration
  create_service         = true
  container_image        = "${module.ecr.repository_url}:latest"
  task_cpu               = 512
  task_memory            = 1024
  service_desired_count  = 2
  enable_autoscaling     = true
  enable_execute_command = true

  container_environment = [
    { name = "DATABASE_HOST", value = module.aurora.cluster_endpoint },
    { name = "DATABASE_PORT", value = tostring(module.aurora.cluster_port) },
    { name = "DATABASE_NAME", value = module.aurora.database_name },
    { name = "DATABASE_USER", value = module.aurora.master_username },
    { name = "DATABASE_SSLMODE", value = "require" },
    { name = "REDIS_HOST", value = module.elasticache.primary_endpoint },
    { name = "REDIS_PORT", value = tostring(module.elasticache.port) },
    { name = "REDIS_TLS", value = "true" },
    { name = "CHALK_ENABLE_DEMO", value = "true" },
    # Note: Cloudflare Calls not enabled yet - omit config to run in limited mode
    # { name = "CLOUDFLARE_ACCOUNT_ID", value = var.cloudflare_account_id },
    { name = "R2_BUCKET_NAME", value = module.cloudflare.recordings_bucket_name },
    { name = "R2_ACCOUNT_ID", value = var.cloudflare_account_id },
  ]

  container_secrets = [
    { name = "DATABASE_PASSWORD", valueFrom = "${module.aurora.master_user_secret_arn}:password::" },
    { name = "REDIS_PASSWORD", valueFrom = module.elasticache.auth_token_secret_arn },
    { name = "JWT_SIGNING_KEY", valueFrom = module.secrets.jwt_secret_arn },
    # Note: Cloudflare Calls API secrets omitted - Calls not enabled yet (403)
    # Add these back when Cloudflare Calls is activated:
    # { name = "CLOUDFLARE_API_TOKEN", valueFrom = "${module.secrets.cloudflare_secret_arn}:sfu_app_secret::" },
    # { name = "CLOUDFLARE_APP_ID", valueFrom = "${module.secrets.cloudflare_secret_arn}:sfu_app_id::" },
  ]

  # Note: No explicit depends_on needed - implicit dependencies from aurora/elasticache/secrets
  # outputs handle ordering. Explicit depends_on causes cycle due to security group cross-refs.
}

module "aurora" {
  source = "../../modules/aurora"

  environment = local.environment
  vpc_id      = module.vpc.vpc_id
  subnet_ids  = module.vpc.database_subnet_ids
  # Allow both ECS instances (EC2 host) and ECS tasks (awsvpc containers) to connect
  allowed_security_group_ids = compact([
    module.ecs.ecs_instances_security_group_id,
    module.ecs.ecs_tasks_security_group_id,
  ])

  engine_version = "16.4"
  database_name  = "chalk"

  min_capacity   = 2
  max_capacity   = 16
  instance_count = 2

  backup_retention_period = 14
  deletion_protection     = true

  performance_insights_enabled          = true
  performance_insights_retention_period = 31
  monitoring_interval                   = 30

  log_retention_days = 90
}

module "elasticache" {
  source = "../../modules/elasticache"

  environment = local.environment
  vpc_id      = module.vpc.vpc_id
  subnet_ids  = module.vpc.database_subnet_ids
  # Allow both ECS instances (EC2 host) and ECS tasks (awsvpc containers) to connect
  allowed_security_group_ids = compact([
    module.ecs.ecs_instances_security_group_id,
    module.ecs.ecs_tasks_security_group_id,
  ])

  engine_version     = "7.1"
  node_type          = "cache.r6g.large"
  num_cache_clusters = 3
  multi_az_enabled   = true

  snapshot_retention_limit = 7
  log_retention_days       = 30
}

module "secrets" {
  source = "../../modules/secrets"

  environment           = local.environment
  cloudflare_app_id     = var.cloudflare_app_id
  cloudflare_app_secret = var.cloudflare_app_secret
}

# DNS and SSL certificates (must come before api_gateway)
module "dns" {
  source = "../../modules/dns"

  environment          = local.environment
  cloudflare_zone_name = var.cloudflare_zone_name
  api_domain           = var.api_domain_name
  api_subdomain        = "chalk-api"

  # These are set to null initially - CNAME records created separately below
  api_gateway_domain_target = null
  frontend_subdomain        = null
  frontend_target           = null

  cloudflare_proxy_enabled = true
}

module "api_gateway" {
  source = "../../modules/api-gateway"

  environment        = local.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  alb_listener_arn   = module.ecs.https_listener_arn != null ? module.ecs.https_listener_arn : module.ecs.http_listener_arn
  alb_dns_name       = module.ecs.alb_dns_name

  domain_name     = var.api_domain_name
  certificate_arn = module.dns.certificate_validated_arn

  cors_allowed_origins = var.cors_allowed_origins

  throttling_burst_limit           = 10000
  throttling_rate_limit            = 20000
  websocket_throttling_burst_limit = 5000
  websocket_throttling_rate_limit  = 10000

  log_retention_days = 90
}

# Cloudflare DNS record for API Gateway (created after api_gateway module)
resource "cloudflare_dns_record" "api" {
  # Use explicit flag - value won't be known at plan time
  count = var.api_domain_name != null ? 1 : 0

  zone_id = module.dns.cloudflare_zone_id
  name    = "chalk-api"
  content = module.api_gateway.custom_domain_target
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

# Cloudflare DNS record for frontend (Cloudflare Pages)
resource "cloudflare_dns_record" "frontend" {
  count = var.frontend_target != null ? 1 : 0

  zone_id = module.dns.cloudflare_zone_id
  name    = "chalk"
  content = var.frontend_target
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

module "waf" {
  source = "../../modules/waf"

  environment = local.environment
  alb_arn     = module.ecs.alb_arn
  rate_limit  = 5000

  # WAF v2 only supports REST APIs (v1), not HTTP APIs (v2)
  # Protect via ALB association instead
  enable_alb_association      = true
  enable_http_api_association = false

  log_retention_days = 90
}

module "monitoring" {
  source = "../../modules/monitoring"

  environment = local.environment

  ecs_cluster_name = module.ecs.cluster_name
  alb_arn          = module.ecs.alb_arn
  alb_arn_suffix   = replace(module.ecs.alb_arn, "/^.*:loadbalancer\\//", "")

  aurora_cluster_id          = module.aurora.cluster_identifier
  aurora_max_connections     = 500
  redis_replication_group_id = module.elasticache.replication_group_id
  api_gateway_id             = module.api_gateway.http_api_id

  alert_emails = var.alert_emails
}

module "cloudflare" {
  source = "../../modules/cloudflare"

  enabled                  = var.enable_cloudflare
  enable_calls             = false # Cloudflare Calls API returns 403 - requires separate activation
  cloudflare_account_id    = var.cloudflare_account_id
  environment              = local.environment
  r2_location              = "enam"
  recording_retention_days = 90 # Prod: full retention
}

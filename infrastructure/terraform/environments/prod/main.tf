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
  availability_zones = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"] # Keep 3 AZs (subnets are free)

  enable_nat_gateway   = true
  single_nat_gateway   = true  # Changed from false ($99→$33/mo)
  enable_vpc_endpoints = false # Disabled to save $29/mo (use NAT for AWS service traffic)
  enable_flow_logs     = true

  flow_logs_retention_days = 14 # Reduced from 90
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

  instance_type    = "t3.small" # Downsized from t3.large ($182→$15/mo)
  min_capacity     = 1          # Downsized from 3
  max_capacity     = 2          # Downsized from 10
  desired_capacity = 1          # Downsized from 3

  # ALB must be internet-facing for WebSocket support
  # VPC Link V2 (HTTP API) doesn't support WebSocket upgrade
  internal_alb          = false
  enable_https_listener = true
  certificate_arn       = module.dns.certificate_validated_arn
  log_retention_days    = 30 # Reduced from 90

  # ECS Service configuration
  create_service         = true
  container_image        = "${module.ecr.repository_url}:latest"
  task_cpu               = 256   # Reduced from 512 (t3.small has less CPU)
  task_memory            = 512   # Reduced from 1024 (t3.small has 2GB)
  service_desired_count  = 1     # Downsized from 2
  enable_autoscaling     = false # Disabled for cost savings
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
    { name = "CLOUDFLARE_ACCOUNT_ID", value = "5281943bd26d5bdcf4c3915606cd6bfb" },
    { name = "CLOUDFLARE_APP_ID", value = "c645c6d1-909c-4643-a733-1da00ded9522" },
    { name = "CLOUDFLARE_API_TOKEN", value = "MesahQRKmgqzvNsebp0rAGbuJB7w3L-ybwl_oMpo" },
    { name = "R2_BUCKET_NAME", value = module.cloudflare.recordings_bucket_name },
    { name = "R2_ACCOUNT_ID", value = var.cloudflare_account_id },
  ]

  container_secrets = [
    { name = "DATABASE_PASSWORD", valueFrom = "${module.aurora.master_user_secret_arn}:password::" },
    { name = "REDIS_PASSWORD", valueFrom = module.elasticache.auth_token_secret_arn },
    { name = "JWT_SIGNING_KEY", valueFrom = module.secrets.jwt_secret_arn },
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

  min_capacity   = 0.5 # Downsized from 2 ACU ($350→$44/mo)
  max_capacity   = 2   # Downsized from 16 ACU (still auto-scales if needed)
  instance_count = 1   # Downsized from 2 (no HA for 200 MAU)

  backup_retention_period = 7     # Reduced from 14
  deletion_protection     = false # Changed to allow instance reduction

  performance_insights_enabled          = true
  performance_insights_retention_period = 7  # Reduced from 31 (free tier)
  monitoring_interval                   = 60 # Reduced from 30

  log_retention_days = 30
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
  node_type          = "cache.t3.micro" # Downsized from cache.r6g.large ($460→$24/mo)
  num_cache_clusters = 2                # Minimum 2 for auto-failover (down from 3)
  multi_az_enabled   = true             # Keep for reliability (free with 2 nodes)

  snapshot_retention_limit = 1 # Reduced from 7
  log_retention_days       = 14
  apply_immediately        = true # Force immediate node type change
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

  throttling_burst_limit           = 2000 # Reduced from 10000 (sufficient for 200 MAU)
  throttling_rate_limit            = 5000 # Reduced from 20000
  websocket_throttling_burst_limit = 1000 # Reduced from 5000
  websocket_throttling_rate_limit  = 2000 # Reduced from 10000

  log_retention_days = 14 # Reduced from 90
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
  rate_limit  = 2000 # Reduced from 5000 (sufficient for 200 MAU)

  # WAF v2 only supports REST APIs (v1), not HTTP APIs (v2)
  # Protect via ALB association instead
  enable_alb_association      = true
  enable_http_api_association = false

  log_retention_days = 7 # Reduced from 90
}

module "monitoring" {
  source = "../../modules/monitoring"

  environment = local.environment

  ecs_cluster_name = module.ecs.cluster_name
  alb_arn          = module.ecs.alb_arn
  alb_arn_suffix   = replace(module.ecs.alb_arn, "/^.*:loadbalancer\\//", "")

  aurora_cluster_id          = module.aurora.cluster_identifier
  aurora_max_connections     = 100 # Reduced from 500 (0.5 ACU has fewer connections)
  redis_replication_group_id = module.elasticache.replication_group_id
  api_gateway_id             = module.api_gateway.http_api_id

  alert_emails = var.alert_emails
}

module "cloudflare" {
  source = "../../modules/cloudflare"

  enabled                  = var.enable_cloudflare
  cloudflare_account_id    = var.cloudflare_account_id
  environment              = local.environment
  r2_location              = "enam"
  recording_retention_days = 30 # Reduced from 90 (cost savings)
}

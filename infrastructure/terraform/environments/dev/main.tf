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
    key            = "dev/terraform.tfstate"
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
  environment = "dev"
}

module "vpc" {
  source = "../../modules/vpc"

  environment        = local.environment
  cidr_block         = "10.0.0.0/16"
  availability_zones = ["${var.aws_region}a", "${var.aws_region}b"]

  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_vpc_endpoints = true
  enable_flow_logs     = true
}

module "ecr" {
  source = "../../modules/ecr"

  environment         = local.environment
  image_count_to_keep = 10
}

module "ecs" {
  source = "../../modules/ecs"

  environment        = local.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids

  instance_type    = "t3.small"
  min_capacity     = 1
  max_capacity     = 2
  desired_capacity = 1

  internal_alb                   = true
  log_retention_days             = 14
  enable_alb_access_logs         = true
  alb_access_logs_prefix         = "alb"
  alb_access_logs_retention_days = 14
}

module "aurora" {
  source = "../../modules/aurora"

  environment                = local.environment
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.ecs.ecs_instances_security_group_id]

  engine_version = "16.4"
  database_name  = "chalk"

  min_capacity   = 0.5
  max_capacity   = 2
  instance_count = 1

  backup_retention_period = 1
  deletion_protection     = false

  performance_insights_enabled = true
  monitoring_interval          = 60
}

module "elasticache" {
  source = "../../modules/elasticache"

  environment                = local.environment
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.database_subnet_ids
  allowed_security_group_ids = [module.ecs.ecs_instances_security_group_id]

  engine_version     = "7.1"
  node_type          = "cache.t3.micro"
  num_cache_clusters = 1
  multi_az_enabled   = false

  snapshot_retention_limit = 0
}

module "secrets" {
  source = "../../modules/secrets"

  environment = local.environment

  # Post-meeting transcription & AI (optional in dev)
  groq_api_key       = var.groq_api_key
  openrouter_api_key = var.openrouter_api_key
}

module "api_gateway" {
  source = "../../modules/api-gateway"

  environment        = local.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  alb_listener_arn   = module.ecs.http_listener_arn
  alb_dns_name       = module.ecs.alb_dns_name

  cors_allowed_origins = ["*"]
  log_retention_days   = 7
}

module "waf" {
  source = "../../modules/waf"

  environment            = local.environment
  alb_arn                = module.ecs.alb_arn
  enable_alb_association = true
  rate_limit             = 2000

  log_retention_days = 7
}

module "monitoring" {
  source = "../../modules/monitoring"

  environment = local.environment

  ecs_cluster_name            = module.ecs.cluster_name
  ecs_log_group_name          = module.ecs.log_group_name
  alb_arn                     = module.ecs.alb_arn
  alb_arn_suffix              = regexreplace(module.ecs.alb_arn, "^.*:loadbalancer/", "")
  alb_target_group_arn_suffix = regexreplace(module.ecs.target_group_arn, "^.*:targetgroup/", "")

  aurora_cluster_id          = module.aurora.cluster_identifier
  redis_replication_group_id = module.elasticache.replication_group_id
  api_gateway_id             = module.api_gateway.http_api_id

  alert_emails = var.alert_emails
}

module "cloudflare" {
  source = "../../modules/cloudflare"

  enabled                  = var.enable_cloudflare
  cloudflare_account_id    = var.cloudflare_account_id
  environment              = local.environment
  r2_location              = "enam" # Eastern North America - matches us-east-1
  recording_retention_days = 30     # Dev: shorter retention
}

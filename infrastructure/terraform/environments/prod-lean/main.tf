terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
    upstash = {
      source  = "upstash/upstash"
      version = "~> 2.1"
    }
    planetscale = {
      source  = "planetscale/planetscale"
      version = "1.0.0-rc1"
    }
  }

  backend "s3" {
    bucket         = "chalk-terraform-state-688819141892"
    key            = "prod-lean/terraform.tfstate"
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
      Stack       = "lean"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "upstash" {
  email   = var.upstash_email
  api_key = var.upstash_api_key
}

provider "planetscale" {
  service_token_id = var.planetscale_service_token_id
  service_token    = var.planetscale_service_token
}

locals {
  environment = "prod-lean"

  api_domain = "${var.api_subdomain}.${var.cloudflare_zone_name}"
  ws_domain  = "${var.ws_subdomain}.${var.cloudflare_zone_name}"

  redis_scheme = var.upstash_tls ? "rediss" : "redis"
  redis_url = format(
    "%s://:%s@%s:%d",
    local.redis_scheme,
    urlencode(upstash_redis_database.control_plane.password),
    upstash_redis_database.control_plane.endpoint,
    upstash_redis_database.control_plane.port,
  )

  plain_env = {
    ENV                              = "production"
    PORT                             = "8080"
    DATABASE_HOST                    = planetscale_postgres_branch_role.api.access_host_url
    DATABASE_PORT                    = "5432"
    DATABASE_NAME                    = var.planetscale_database
    DATABASE_USER                    = planetscale_postgres_branch_role.api.username
    DATABASE_SSLMODE                 = "require"
    DATABASE_MAX_CONNS               = tostring(var.db_max_conns)
    DATABASE_MIN_CONNS               = tostring(var.db_min_conns)
    REDIS_HOST                       = upstash_redis_database.control_plane.endpoint
    REDIS_PORT                       = tostring(upstash_redis_database.control_plane.port)
    REDIS_TLS                        = tostring(var.upstash_tls)
    CHALK_ENABLE_DEMO                = "true"
    CLOUDFLARE_ACCOUNT_ID            = var.cloudflare_account_id
    CLOUDFLARE_APP_ID                = var.cloudflare_app_id
    R2_BUCKET_NAME                   = module.cloudflare.recordings_bucket_name
    R2_ACCOUNT_ID                    = var.cloudflare_account_id
    GITHUB_OWNER                     = var.github_owner
    GITHUB_REPO                      = var.github_repo
    AXIOM_DATASET                    = var.axiom_dataset
    AXIOM_DOMAIN                     = "api.axiom.co"
    AXIOM_TRACES_DATASET             = var.axiom_traces_dataset
    OTEL_TRACE_SAMPLER_RATIO         = "0.1"
    POST_MEETING_WHISPER_ENABLED     = "false"
    POST_MEETING_WHISPER_REDIS_QUEUE = "transcription:jobs"
    RESEND_FROM_EMAIL                = var.resend_from_email
    INTERNAL_APP_URL                 = var.internal_app_url
    AUTH_COOKIE_DOMAIN               = var.auth_cookie_domain
    API_PUBLIC_URL                   = "https://${local.api_domain}"
    ADMIN_ENABLED                    = "true"
    ADMIN_ALLOWED_IPS                = var.admin_allowed_ips
  }

  secure_env_required = {
    DATABASE_PASSWORD    = planetscale_postgres_branch_role.api.password
    REDIS_URL            = local.redis_url
    CLOUDFLARE_API_TOKEN = var.cloudflare_app_token
    R2_ACCESS_KEY_ID     = var.r2_access_key_id
    R2_SECRET_ACCESS_KEY = var.r2_secret_access_key
    ADMIN_SECRET         = var.admin_secret
    JWT_SIGNING_KEY      = var.jwt_signing_key
  }

  plain_env_parameters = local.plain_env

}

module "ecr" {
  source = "../../modules/ecr"

  environment = local.environment

  image_tag_mutability = "MUTABLE"
  image_count_to_keep  = 30
}

module "cloudflare" {
  source = "../../modules/cloudflare"

  enabled                  = true
  cloudflare_account_id    = var.cloudflare_account_id
  environment              = local.environment
  r2_location              = "enam"
  recording_retention_days = 30
}

data "cloudflare_zones" "main" {
  name = var.cloudflare_zone_name
}

locals {
  zone_id = data.cloudflare_zones.main.result[0].id
}

resource "planetscale_postgres_branch_role" "api" {
  organization = var.planetscale_organization
  database     = var.planetscale_database
  branch       = var.planetscale_branch
  name         = "api"
}

resource "upstash_redis_database" "control_plane" {
  database_name  = var.upstash_database_name
  region         = "global"
  primary_region = var.upstash_region
  tls            = var.upstash_tls
  eviction       = var.upstash_eviction
}

resource "aws_ssm_parameter" "plain_env" {
  for_each = local.plain_env_parameters

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/${each.key}"
  type  = "String"
  value = each.value

  tags = {
    Environment = local.environment
    Project     = "chalk"
    Stack       = "lean"
  }
}

resource "aws_ssm_parameter" "secure_env" {
  for_each = toset(keys(local.secure_env_required))

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/${each.value}"
  type  = "SecureString"
  value = local.secure_env_required[each.value]

  tags = {
    Environment = local.environment
    Project     = "chalk"
    Stack       = "lean"
  }
}

resource "aws_ssm_parameter" "axiom_token" {
  count = trimspace(nonsensitive(var.axiom_token)) != "" ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/AXIOM_TOKEN"
  type  = "SecureString"
  value = var.axiom_token
}

resource "aws_ssm_parameter" "github_token" {
  count = trimspace(nonsensitive(var.github_token)) != "" ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/GITHUB_TOKEN"
  type  = "SecureString"
  value = var.github_token
}

resource "aws_ssm_parameter" "openrouter_api_key" {
  count = trimspace(nonsensitive(var.openrouter_api_key)) != "" ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/POST_MEETING_OPENROUTER_API_KEY"
  type  = "SecureString"
  value = var.openrouter_api_key
}

resource "aws_ssm_parameter" "groq_api_key" {
  count = trimspace(nonsensitive(var.groq_api_key)) != "" ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/POST_MEETING_GROQ_API_KEY"
  type  = "SecureString"
  value = var.groq_api_key
}

resource "aws_ssm_parameter" "cloudflare_webhook_secret" {
  count = trimspace(nonsensitive(var.cloudflare_webhook_secret)) != "" ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/CLOUDFLARE_WEBHOOK_SECRET"
  type  = "SecureString"
  value = var.cloudflare_webhook_secret
}

resource "aws_ssm_parameter" "auth_link_signing_key" {
  count = trimspace(nonsensitive(var.auth_link_signing_key)) != "" ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/AUTH_LINK_SIGNING_KEY"
  type  = "SecureString"
  value = var.auth_link_signing_key
}

resource "aws_ssm_parameter" "resend_api_key" {
  count = trimspace(nonsensitive(var.resend_api_key)) != "" ? 1 : 0

  name  = "${trimsuffix(var.ssm_parameter_path, "/")}/RESEND_API_KEY"
  type  = "SecureString"
  value = var.resend_api_key
}

module "ec2_api" {
  source = "../../modules/ec2-api-lean"

  environment        = local.environment
  aws_region         = var.aws_region
  instance_type      = var.instance_type
  api_domain         = local.api_domain
  ws_domain          = local.ws_domain
  ecr_repository_arn = module.ecr.repository_arn
  container_image    = "${module.ecr.repository_url}:latest"
  ssm_parameter_path = var.ssm_parameter_path
  app_env_static     = {}
  ssh_ingress_cidrs  = var.ssh_ingress_cidrs
  alert_actions      = var.alert_actions
}

resource "cloudflare_dns_record" "api" {
  count = var.manage_dns_records ? 1 : 0

  zone_id = local.zone_id
  name    = var.api_subdomain
  content = module.ec2_api.public_ip
  type    = "A"
  ttl     = var.cloudflare_proxy_enabled ? 1 : 300
  proxied = var.cloudflare_proxy_enabled
}

resource "cloudflare_dns_record" "websocket" {
  count = var.manage_dns_records ? 1 : 0

  zone_id = local.zone_id
  name    = var.ws_subdomain
  content = module.ec2_api.public_ip
  type    = "A"
  ttl     = var.cloudflare_proxy_enabled ? 1 : 300
  proxied = var.cloudflare_proxy_enabled
}

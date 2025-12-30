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
  }
}

locals {
  name = "chalk-${var.environment}"

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "dns"
  })
}

# Look up the Cloudflare zone by domain name
data "cloudflare_zone" "main" {
  name = var.cloudflare_zone_name
}

# ACM Certificate for API domain
resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.tags, {
    Name = "${local.name}-api-cert"
  })
}

# Cloudflare DNS record for ACM validation
resource "cloudflare_dns_record" "acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = data.cloudflare_zone.main.id
  name    = trimsuffix(each.value.name, ".${var.cloudflare_zone_name}.")
  content = trimsuffix(each.value.record, ".")
  type    = each.value.type
  ttl     = 300
  proxied = false
}

# Wait for ACM certificate validation
resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for record in cloudflare_dns_record.acm_validation : "${record.name}.${var.cloudflare_zone_name}"]
}

# Cloudflare DNS record for API Gateway custom domain
resource "cloudflare_dns_record" "api" {
  count = var.api_gateway_domain_target != null ? 1 : 0

  zone_id = data.cloudflare_zone.main.id
  name    = var.api_subdomain
  content = var.api_gateway_domain_target
  type    = "CNAME"
  ttl     = 1 # Auto TTL when proxied
  proxied = var.cloudflare_proxy_enabled
}

# Cloudflare DNS record for frontend (Cloudflare Pages or custom target)
resource "cloudflare_dns_record" "frontend" {
  count = var.frontend_target != null ? 1 : 0

  zone_id = data.cloudflare_zone.main.id
  name    = var.frontend_subdomain
  content = var.frontend_target
  type    = "CNAME"
  ttl     = 1 # Auto TTL when proxied
  proxied = var.cloudflare_proxy_enabled
}

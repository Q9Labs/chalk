# Network side of the direct Sync path for one managed host: a security group that
# opens inbound 443 and nothing else, and DNS-only records for the direct hostname.
# Nothing here changes Sync, the Tunnel, the host's other security groups, or any
# other DNS record. `tofu destroy` is the exact undo.
terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # The operator supplies bucket, key and credentials through backend config, so no
  # state location enters the repository.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
}

provider "cloudflare" {}

data "aws_instance" "host" {
  instance_id = var.instance_id

  lifecycle {
    postcondition {
      condition     = self.tags["chalk:environment"] == var.environment
      error_message = "The instance is not tagged for the selected environment."
    }
  }
}

data "aws_subnet" "host" {
  id = data.aws_instance.host.subnet_id
}

resource "aws_security_group" "direct_sync" {
  name        = "chalk-${var.environment}-direct-sync"
  description = "Inbound 443 for the direct Sync path"
  vpc_id      = data.aws_subnet.host.vpc_id

  tags = {
    Name                = "chalk-${var.environment}-direct-sync"
    "chalk:environment" = var.environment
  }
}

resource "aws_vpc_security_group_ingress_rule" "https_ipv4" {
  security_group_id = aws_security_group.direct_sync.id
  description       = "Direct Sync TLS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "https_ipv6" {
  count = var.ipv6_address == null ? 0 : 1

  security_group_id = aws_security_group.direct_sync.id
  description       = "Direct Sync TLS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv6         = "::/0"
}

resource "aws_network_interface_sg_attachment" "direct_sync" {
  security_group_id    = aws_security_group.direct_sync.id
  network_interface_id = data.aws_instance.host.network_interface_id
}

# DNS only: Cloudflare must not proxy this name, or the path is the Tunnel again.
resource "cloudflare_dns_record" "ipv4" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "A"
  content = var.ipv4_address
  ttl     = 60
  proxied = false
  comment = "chalk direct sync (${var.environment})"
}

resource "cloudflare_dns_record" "ipv6" {
  count = var.ipv6_address == null ? 0 : 1

  zone_id = var.zone_id
  name    = var.hostname
  type    = "AAAA"
  content = var.ipv6_address
  ttl     = 60
  proxied = false
  comment = "chalk direct sync (${var.environment})"
}

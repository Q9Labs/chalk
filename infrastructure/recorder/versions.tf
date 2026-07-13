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

    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.48"
    }
  }

  # CI and operators provide the bucket, key, and credentials through an
  # environment-specific backend config. Keeping the block empty prevents
  # credentials or provider identifiers from entering this repository.
  backend "s3" {}
}

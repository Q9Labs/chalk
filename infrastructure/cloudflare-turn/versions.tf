terraform {
  required_version = "= 1.12.3"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.9.0"
    }
  }

  # Supply the environment's state bucket through -backend-config. Account IDs
  # and credentials must never be committed.
  backend "s3" {}
}

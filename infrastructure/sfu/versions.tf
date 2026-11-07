terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.48"
    }
  }

  # backend.hcl names the environment's own state bucket and key, privately.
  backend "s3" {}
}

# The token comes from DIGITALOCEAN_TOKEN, never from a tracked file.
provider "digitalocean" {}

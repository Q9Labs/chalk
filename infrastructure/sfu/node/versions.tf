terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.48"
    }
  }
}

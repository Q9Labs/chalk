provider "aws" {
  alias  = "recording"
  region = var.kms_region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "digitalocean" {
  alias = "capture"
  token = var.capture_provider_token
}

provider "digitalocean" {
  alias = "render"
  token = var.render_provider_token
}

data "aws_caller_identity" "current" {
  count    = var.enable_apply ? 1 : 0
  provider = aws.recording
}

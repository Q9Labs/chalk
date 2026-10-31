provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Cloudflare shows the key value only at creation, so it lives in this
# environment's state (an encrypted backend) and leaves through the sensitive
# output below. The API turns it into short-lived credentials per join.
resource "cloudflare_calls_turn_app" "this" {
  account_id = var.cloudflare_account_id
  name       = "chalk-${var.environment_name}-turn"
}

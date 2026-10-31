output "turn_key_id" {
  description = "Value for CHALK_CLOUDFLARE_TURN_KEY_ID."
  value       = cloudflare_calls_turn_app.this.uid
}

output "turn_api_token" {
  description = "Value for CHALK_CLOUDFLARE_TURN_API_TOKEN."
  value       = cloudflare_calls_turn_app.this.key
  sensitive   = true
}

# SFU App outputs - needed for RealtimeKit SDK
output "sfu_app_id" {
  description = "Cloudflare Calls SFU App ID"
  value       = cloudflare_calls_sfu_app.main.uid
}

output "sfu_app_secret" {
  description = "Cloudflare Calls SFU App Secret"
  value       = cloudflare_calls_sfu_app.main.secret
  sensitive   = true
}

# TURN App outputs - needed for WebRTC NAT traversal
output "turn_app_id" {
  description = "Cloudflare Calls TURN App ID"
  value       = cloudflare_calls_turn_app.main.uid
}

output "turn_app_key" {
  description = "Cloudflare Calls TURN App Key"
  value       = cloudflare_calls_turn_app.main.key
  sensitive   = true
}

# R2 Bucket outputs - needed for recording uploads
output "recordings_bucket_name" {
  description = "R2 bucket name for recordings"
  value       = cloudflare_r2_bucket.recordings.name
}

output "recordings_bucket_location" {
  description = "R2 bucket location"
  value       = cloudflare_r2_bucket.recordings.location
}

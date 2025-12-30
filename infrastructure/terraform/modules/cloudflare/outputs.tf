# SFU App outputs - needed for RealtimeKit SDK
output "sfu_app_id" {
  description = "Cloudflare Calls SFU App ID"
  value       = try(cloudflare_calls_sfu_app.main[0].uid, null)
}

output "sfu_app_secret" {
  description = "Cloudflare Calls SFU App Secret"
  value       = try(cloudflare_calls_sfu_app.main[0].secret, null)
  sensitive   = true
}

# TURN App outputs - needed for WebRTC NAT traversal
output "turn_app_id" {
  description = "Cloudflare Calls TURN App ID"
  value       = try(cloudflare_calls_turn_app.main[0].uid, null)
}

output "turn_app_key" {
  description = "Cloudflare Calls TURN App Key"
  value       = try(cloudflare_calls_turn_app.main[0].key, null)
  sensitive   = true
}

# R2 Bucket outputs - needed for recording uploads
output "recordings_bucket_name" {
  description = "R2 bucket name for recordings"
  value       = try(cloudflare_r2_bucket.recordings[0].name, null)
}

output "recordings_bucket_location" {
  description = "R2 bucket location"
  value       = try(cloudflare_r2_bucket.recordings[0].location, null)
}

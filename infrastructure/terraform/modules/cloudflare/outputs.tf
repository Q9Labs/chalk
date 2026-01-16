# R2 Bucket outputs - needed for recording uploads
output "recordings_bucket_name" {
  description = "R2 bucket name for recordings"
  value       = try(cloudflare_r2_bucket.recordings[0].name, null)
}

output "recordings_bucket_location" {
  description = "R2 bucket location"
  value       = try(cloudflare_r2_bucket.recordings[0].location, null)
}

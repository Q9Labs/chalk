output "bucket_name" {
  description = "Existing bucket whose lifecycle configuration is managed."
  value       = var.bucket_name
}

output "temporary_prefixes" {
  description = "Prefixes covered by the 24-hour orphan cleanup safety net."
  value       = var.temporary_prefixes
}

output "temporary_expiration_hours" {
  description = "Lifecycle orphan expiration in hours."
  value       = var.temporary_expiration_hours
}

output "committed_cleanup_deadline_hours" {
  description = "Application-owned committed cleanup deadline; no finalized prefix is covered by lifecycle."
  value       = var.committed_cleanup_deadline_hours
}

output "security_group_id" {
  value = aws_security_group.direct_sync.id
}

output "direct_sync_url" {
  description = "Value for the client flag: the SDK syncDirectUrl, or CHALK_WEB_SYNC_DIRECT_URL for the web release."
  value       = "wss://${var.hostname}/v1/sync"
}

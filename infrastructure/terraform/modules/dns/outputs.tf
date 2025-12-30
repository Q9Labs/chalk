output "certificate_arn" {
  description = "ACM certificate ARN"
  value       = aws_acm_certificate.api.arn
}

output "certificate_validated_arn" {
  description = "ACM certificate ARN (after validation)"
  value       = aws_acm_certificate_validation.api.certificate_arn
}

output "cloudflare_zone_id" {
  description = "Cloudflare zone ID"
  value       = data.cloudflare_zone.main.id
}

output "api_domain" {
  description = "Full API domain"
  value       = var.api_domain
}

output "frontend_domain" {
  description = "Full frontend domain"
  value       = var.frontend_subdomain != null ? "${var.frontend_subdomain}.${var.cloudflare_zone_name}" : null
}

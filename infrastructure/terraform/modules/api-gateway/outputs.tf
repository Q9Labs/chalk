output "http_api_id" {
  description = "HTTP API ID"
  value       = aws_apigatewayv2_api.http.id
}

output "http_api_arn" {
  description = "HTTP API ARN"
  value       = aws_apigatewayv2_api.http.arn
}

output "http_stage_arn" {
  description = "HTTP API Stage ARN for WAF association"
  value       = "arn:aws:apigateway:${data.aws_region.current.name}::/apis/${aws_apigatewayv2_api.http.id}/stages/${aws_apigatewayv2_stage.http.name}"
}

output "http_api_endpoint" {
  description = "HTTP API endpoint URL"
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "http_api_execution_arn" {
  description = "HTTP API execution ARN"
  value       = aws_apigatewayv2_api.http.execution_arn
}

output "websocket_api_id" {
  description = "WebSocket API ID"
  value       = aws_apigatewayv2_api.websocket.id
}

output "websocket_api_arn" {
  description = "WebSocket API ARN"
  value       = aws_apigatewayv2_api.websocket.arn
}

output "websocket_api_endpoint" {
  description = "WebSocket API endpoint URL"
  value       = aws_apigatewayv2_api.websocket.api_endpoint
}

output "websocket_api_execution_arn" {
  description = "WebSocket API execution ARN"
  value       = aws_apigatewayv2_api.websocket.execution_arn
}

output "vpc_link_id" {
  description = "VPC Link ID"
  value       = aws_apigatewayv2_vpc_link.main.id
}

output "vpc_link_arn" {
  description = "VPC Link ARN"
  value       = aws_apigatewayv2_vpc_link.main.arn
}

output "custom_domain_name" {
  description = "Custom domain name"
  value       = try(aws_apigatewayv2_domain_name.main[0].domain_name, null)
}

output "custom_domain_target" {
  description = "Custom domain target for Route53 alias"
  value       = try(aws_apigatewayv2_domain_name.main[0].domain_name_configuration[0].target_domain_name, null)
}

output "custom_domain_zone_id" {
  description = "Custom domain hosted zone ID for Route53"
  value       = try(aws_apigatewayv2_domain_name.main[0].domain_name_configuration[0].hosted_zone_id, null)
}

output "http_stage_id" {
  description = "HTTP API stage ID"
  value       = aws_apigatewayv2_stage.http.id
}

output "websocket_stage_id" {
  description = "WebSocket API stage ID"
  value       = aws_apigatewayv2_stage.websocket.id
}

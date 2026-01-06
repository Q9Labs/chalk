terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

locals {
  name = "chalk-${var.environment}"

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "api-gateway"
  })
}

data "aws_region" "current" {}

# IAM role for API Gateway to write to CloudWatch Logs
resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "${local.name}-api-gateway-cloudwatch"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "apigateway.amazonaws.com"
        }
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "api_gateway_cloudwatch" {
  name = "${local.name}-api-gateway-cloudwatch"
  role = aws_iam_role.api_gateway_cloudwatch.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
          "logs:GetLogEvents",
          "logs:FilterLogEvents"
        ]
        Resource = "*"
      }
    ]
  })
}

# Account-level setting for API Gateway CloudWatch logging
resource "aws_api_gateway_account" "main" {
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn
}

resource "aws_security_group" "vpc_link" {
  name        = "${local.name}-vpc-link-sg"
  description = "Security group for API Gateway VPC Link"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, {
    Name = "${local.name}-vpc-link-sg"
  })
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "${local.name}-vpc-link"
  security_group_ids = [aws_security_group.vpc_link.id]
  subnet_ids         = var.private_subnet_ids

  tags = local.tags
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-http-api"
  protocol_type = "HTTP"
  description   = "HTTP API for Chalk ${var.environment}"

  cors_configuration {
    allow_headers = ["content-type", "authorization", "x-api-key", "x-amz-date"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_origins = var.cors_allowed_origins
    max_age       = 86400
  }

  tags = local.tags
}

resource "aws_apigatewayv2_integration" "http_alb" {
  api_id             = aws_apigatewayv2_api.http.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = var.alb_listener_arn

  connection_type = "VPC_LINK"
  connection_id   = aws_apigatewayv2_vpc_link.main.id

  payload_format_version = "1.0"
  timeout_milliseconds   = 30000

  # TLS verification must use the domain matching the ACM certificate on the ALB
  # The ALB has cert for var.domain_name, not the internal DNS name
  tls_config {
    server_name_to_verify = var.domain_name
  }
}

resource "aws_apigatewayv2_route" "http_default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.http_alb.id}"
}

resource "aws_apigatewayv2_route" "http_root" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "ANY /"
  target    = "integrations/${aws_apigatewayv2_integration.http_alb.id}"
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.http_api.arn
    format = jsonencode({
      requestId         = "$context.requestId"
      ip                = "$context.identity.sourceIp"
      requestTime       = "$context.requestTime"
      httpMethod        = "$context.httpMethod"
      routeKey          = "$context.routeKey"
      status            = "$context.status"
      protocol          = "$context.protocol"
      responseLength    = "$context.responseLength"
      integrationError  = "$context.integrationErrorMessage"
      integrationStatus = "$context.integrationStatus"
      latency           = "$context.responseLatency"
    })
  }

  default_route_settings {
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "http_api" {
  name              = "/aws/apigateway/${local.name}-http-api"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_apigatewayv2_api" "websocket" {
  name                       = "${local.name}-websocket-api"
  protocol_type              = "WEBSOCKET"
  description                = "WebSocket API for Chalk ${var.environment}"
  route_selection_expression = "$request.body.action"

  tags = local.tags
}

# Note: WebSocket APIs don't support VPC Link V2, so we use INTERNET connection type
# The ALB should be public or use Lambda proxy for private backends
resource "aws_apigatewayv2_integration" "websocket_alb" {
  api_id             = aws_apigatewayv2_api.websocket.id
  integration_type   = "HTTP"
  integration_method = "POST"
  integration_uri    = "https://${var.alb_dns_name}/ws"

  connection_type        = "INTERNET"
  timeout_milliseconds   = 29000
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "websocket_connect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.websocket_alb.id}"
}

resource "aws_apigatewayv2_route" "websocket_disconnect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.websocket_alb.id}"
}

resource "aws_apigatewayv2_route" "websocket_default" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.websocket_alb.id}"
}

resource "aws_apigatewayv2_stage" "websocket" {
  api_id      = aws_apigatewayv2_api.websocket.id
  name        = var.environment
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.websocket_api.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      eventType        = "$context.eventType"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      connectionId     = "$context.connectionId"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  default_route_settings {
    throttling_burst_limit = var.websocket_throttling_burst_limit
    throttling_rate_limit  = var.websocket_throttling_rate_limit
  }

  tags = local.tags

  depends_on = [aws_api_gateway_account.main]
}

resource "aws_cloudwatch_log_group" "websocket_api" {
  name              = "/aws/apigateway/${local.name}-websocket-api"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_apigatewayv2_domain_name" "main" {
  count = var.domain_name != null ? 1 : 0

  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = local.tags
}

resource "aws_apigatewayv2_api_mapping" "http" {
  count = var.domain_name != null ? 1 : 0

  api_id          = aws_apigatewayv2_api.http.id
  domain_name     = aws_apigatewayv2_domain_name.main[0].id
  stage           = aws_apigatewayv2_stage.http.id
  api_mapping_key = "" # Root mapping - Go API routes already have /api/v1 prefix
}

resource "aws_apigatewayv2_api_mapping" "websocket" {
  count = var.domain_name != null && var.websocket_domain_name != null ? 1 : 0

  api_id          = aws_apigatewayv2_api.websocket.id
  domain_name     = aws_apigatewayv2_domain_name.main[0].id
  stage           = aws_apigatewayv2_stage.websocket.id
  api_mapping_key = "ws"
}

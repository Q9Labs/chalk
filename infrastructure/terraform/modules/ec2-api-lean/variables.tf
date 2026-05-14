variable "environment" {
  description = "Environment name"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t4g.micro"
}

variable "api_domain" {
  description = "Primary API domain"
  type        = string
}

variable "ws_domain" {
  description = "WebSocket domain"
  type        = string
}

variable "api_port" {
  description = "Container port"
  type        = number
  default     = 8080
}

variable "ecr_repository_arn" {
  description = "ECR repository ARN for pull access"
  type        = string
}

variable "container_image" {
  description = "Default container image"
  type        = string
}

variable "ssm_parameter_path" {
  description = "SSM path containing app env vars"
  type        = string
}

variable "app_env_static" {
  description = "Non-secret app env vars written on host"
  type        = map(string)
  default     = {}
}

variable "ssh_ingress_cidrs" {
  description = "Optional SSH ingress CIDRs"
  type        = list(string)
  default     = []
}

variable "alert_actions" {
  description = "CloudWatch alarm action ARNs"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}

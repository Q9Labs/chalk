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
  default     = "c7i.large"
}

variable "use_spot" {
  description = "Use spot market for the instance"
  type        = bool
  default     = true
}

variable "ecr_repository_arn" {
  description = "ECR repository ARN for pull access"
  type        = string
}

variable "container_image" {
  description = "Container image for whisper worker"
  type        = string
}

variable "ssm_parameter_path" {
  description = "SSM path containing worker env vars"
  type        = string
}

variable "app_env_static" {
  description = "Non-secret worker env vars written on host"
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

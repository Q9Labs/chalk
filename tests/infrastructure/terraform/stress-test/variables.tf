variable "aws_region" {
  description = "AWS region for stress test infrastructure"
  type        = string
  default     = "us-east-1"
}

variable "api_image" {
  description = "Docker image for the API service"
  type        = string
  default     = "ghcr.io/q9labs/chalk-api:latest"
}

variable "db_username" {
  description = "Aurora database master username"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Aurora database master password"
  type        = string
  sensitive   = true
}

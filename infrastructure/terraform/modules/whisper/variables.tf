# Whisper Module Variables

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where Whisper instances will be deployed"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block for security group rules"
  type        = string
}

variable "subnet_ids" {
  description = "List of subnet IDs for Whisper instances"
  type        = list(string)
}

variable "redis_url" {
  description = "Redis URL for job queue"
  type        = string
  sensitive   = true
}

variable "ecr_repository_url" {
  description = "ECR repository URL for whisper worker image"
  type        = string
}

variable "worker_image_tag" {
  description = "Docker image tag for whisper worker"
  type        = string
  default     = "latest"
}

variable "instance_type" {
  description = "EC2 instance type (must be GPU instance)"
  type        = string
  default     = "g4dn.xlarge" # 1 NVIDIA T4 GPU, 4 vCPU, 16GB RAM
}

variable "min_capacity" {
  description = "Minimum number of Whisper instances"
  type        = number
  default     = 0
}

variable "max_capacity" {
  description = "Maximum number of Whisper instances"
  type        = number
  default     = 2
}

variable "desired_capacity" {
  description = "Desired number of Whisper instances"
  type        = number
  default     = 1
}

variable "bastion_security_group_id" {
  description = "Security group ID of bastion host for SSH access (optional)"
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "log_level" {
  description = "Log level for whisper worker (DEBUG, INFO, WARNING, ERROR)"
  type        = string
  default     = "INFO"
}

variable "enable_autoscaling" {
  description = "Enable auto scaling based on queue depth"
  type        = bool
  default     = true
}

variable "scale_up_threshold" {
  description = "Queue depth threshold to scale up"
  type        = number
  default     = 10
}

variable "scale_down_threshold" {
  description = "Queue depth threshold to scale down"
  type        = number
  default     = 2
}

variable "tags" {
  description = "Additional tags for resources"
  type        = map(string)
  default     = {}
}

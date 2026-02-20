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

variable "redis_auth_secret_arn" {
  description = "ARN of the Secrets Manager secret containing Redis AUTH token"
  type        = string
}

variable "axiom_secret_arn" {
  description = "ARN of the Secrets Manager secret containing Axiom credentials"
  type        = string
}

variable "axiom_dataset_whisper" {
  description = "Axiom dataset name for whisper-worker logs (non-secret)"
  type        = string
  default     = "chalk-whisper-work"
}

variable "secrets_kms_key_arn" {
  description = "KMS key ARN used to encrypt Secrets Manager secrets"
  type        = string
}

variable "redis_endpoint" {
  description = "Redis endpoint address"
  type        = string
}

variable "redis_port" {
  description = "Redis port"
  type        = number
  default     = 6379
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
  description = "EC2 instance type for Whisper worker"
  type        = string
  default     = "g4dn.xlarge" # 1 NVIDIA T4 GPU, 4 vCPU, 16GB RAM
}

variable "use_gpu" {
  description = "Enable GPU runtime for Whisper worker (NVIDIA toolkit + docker --gpus all)"
  type        = bool
  default     = true
}

variable "use_spot" {
  description = "Use Spot instances for Whisper worker capacity (cheaper, interruptible)"
  type        = bool
  default     = false
}

variable "spot_instance_interruption_behavior" {
  description = "Spot interruption behavior (terminate | stop | hibernate)"
  type        = string
  default     = "terminate"
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

variable "whisper_device" {
  description = "WHISPER_DEVICE runtime env value"
  type        = string
  default     = "cuda"
}

variable "whisper_compute_type" {
  description = "WHISPER_COMPUTE_TYPE runtime env value"
  type        = string
  default     = "float16"
}

variable "whisper_cpu_threads" {
  description = "WHISPER_CPU_THREADS runtime env value"
  type        = number
  default     = 4
}

variable "whisper_gpu_metrics_enabled" {
  description = "Enable periodic GPU utilization metric export from the worker"
  type        = bool
  default     = true
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

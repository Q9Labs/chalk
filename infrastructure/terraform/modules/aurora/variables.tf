variable "environment" {
  description = "Environment name"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "subnet_ids" {
  description = "Database subnet IDs"
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security group IDs allowed to access Aurora"
  type        = list(string)
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version"
  type        = string
  default     = "16.4"
}

variable "database_name" {
  description = "Name of the default database"
  type        = string
  default     = "chalk"
}

variable "master_username" {
  description = "Master username"
  type        = string
  default     = "chalk_admin"
}

variable "min_capacity" {
  description = "Minimum ACU capacity"
  type        = number
  default     = 0.5
}

variable "max_capacity" {
  description = "Maximum ACU capacity"
  type        = number
  default     = 4
}

variable "instance_count" {
  description = "Number of instances"
  type        = number
  default     = 1
}

variable "backup_retention_period" {
  description = "Days to retain backups"
  type        = number
  default     = 7
}

variable "backup_window" {
  description = "Preferred backup window"
  type        = string
  default     = "03:00-04:00"
}

variable "maintenance_window" {
  description = "Preferred maintenance window"
  type        = string
  default     = "sun:04:00-sun:05:00"
}

variable "deletion_protection" {
  description = "Enable deletion protection"
  type        = bool
  default     = false
}

variable "create_kms_key" {
  description = "Create a new KMS key for encryption"
  type        = bool
  default     = true
}

variable "kms_key_id" {
  description = "Existing KMS key ID (if not creating new)"
  type        = string
  default     = null
}

variable "performance_insights_enabled" {
  description = "Enable Performance Insights"
  type        = bool
  default     = true
}

variable "performance_insights_retention_period" {
  description = "Performance Insights retention period in days"
  type        = number
  default     = 7
}

variable "monitoring_interval" {
  description = "Enhanced monitoring interval in seconds (0 to disable)"
  type        = number
  default     = 60
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

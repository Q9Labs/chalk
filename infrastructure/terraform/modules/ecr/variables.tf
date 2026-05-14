variable "environment" {
  description = "Environment name"
  type        = string
}

variable "image_tag_mutability" {
  description = "Image tag mutability setting"
  type        = string
  default     = "MUTABLE"
}

variable "kms_key_arn" {
  description = "KMS key ARN for encryption"
  type        = string
  default     = null
}

variable "image_count_to_keep" {
  description = "Number of images to keep"
  type        = number
  default     = 30
}

variable "allow_cross_account_access" {
  description = "Allow cross-account access to ECR"
  type        = bool
  default     = false
}

variable "cross_account_principals" {
  description = "AWS principals for cross-account access"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

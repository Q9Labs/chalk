variable "create_service" {
  description = "Whether to create ECS service and task definition"
  type        = bool
  default     = false
}

variable "container_image" {
  description = "Container image to deploy"
  type        = string
  default     = ""
}

variable "task_cpu" {
  description = "Task CPU units"
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Task memory in MB"
  type        = number
  default     = 1024
}

variable "container_secrets" {
  description = "Secrets to inject into container"
  type = list(object({
    name      = string
    valueFrom = string
  }))
  default = []
}

variable "container_environment" {
  description = "Environment variables to inject into container"
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "service_desired_count" {
  description = "Desired number of tasks"
  type        = number
  default     = 2
}

variable "service_min_count" {
  description = "Minimum number of tasks for autoscaling"
  type        = number
  default     = 1
}

variable "service_max_count" {
  description = "Maximum number of tasks for autoscaling"
  type        = number
  default     = 10
}

variable "enable_autoscaling" {
  description = "Enable service autoscaling"
  type        = bool
  default     = true
}

variable "enable_execute_command" {
  description = "Enable ECS Exec for debugging"
  type        = bool
  default     = false
}

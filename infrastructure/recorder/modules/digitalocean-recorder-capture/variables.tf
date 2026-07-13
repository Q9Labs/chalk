variable "environment" {
  type = string
}

variable "desired_nodes" {
  type = number

  validation {
    condition     = var.desired_nodes >= 0 && var.desired_nodes <= 11 && floor(var.desired_nodes) == var.desired_nodes
    error_message = "capture desired_nodes must be an integer between zero and eleven."
  }
}

variable "max_nodes" {
  type    = number
  default = 11
}

variable "node_size" {
  type = string
}

variable "image_id" {
  type = number
}

variable "image_digest" {
  type = string

  validation {
    condition     = var.image_digest == "" || can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "capture image_digest must be an attested sha256 digest."
  }
}

variable "release_id" {
  type = string
}

variable "bootstrap_endpoint" {
  type = string
}

variable "enable_apply" {
  type = bool
}

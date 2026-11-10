variable "environment" {
  type        = string
  description = "Environment this root applies to. Only nightly for now; the instance must carry the same chalk:environment tag."

  validation {
    condition     = var.environment == "nightly"
    error_message = "This root applies to the nightly environment only. Widen this check in a reviewed change before using it elsewhere."
  }
}

variable "aws_region" {
  type        = string
  description = "Region of the managed host."
}

variable "instance_id" {
  type        = string
  description = "EC2 instance id of the managed host that runs Sync."
}

variable "hostname" {
  type        = string
  description = "Direct Sync hostname, for example the environment's Sync name with a direct label."

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.hostname))
    error_message = "hostname must be a lowercase DNS name."
  }
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone id that holds the hostname."
}

variable "ipv4_address" {
  type        = string
  description = "Public IPv4 address of the host. It must be stable across stop and start, for example an Elastic IP."
}

variable "ipv6_address" {
  type        = string
  default     = null
  description = "Public IPv6 address of the host. Leave null when its subnet has no IPv6; no AAAA record or IPv6 rule is created."
}

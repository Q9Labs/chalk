# One Chalk SFU node per environment. Run this root once per environment, each
# with its own backend.hcl and tfvars.
module "node" {
  source = "./node"

  environment       = var.environment
  size              = var.size
  control_addresses = var.control_addresses
}

variable "environment" {
  type = string
}

variable "size" {
  type    = string
  default = "s-1vcpu-1gb"
}

variable "control_addresses" {
  description = "The API host's public address in CIDR form. Supply it privately."
  type        = list(string)
}

output "name" {
  value = module.node.name
}

output "public_ip" {
  value     = module.node.public_ip
  sensitive = true
}

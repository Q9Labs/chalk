variable "environment" {
  description = "staging or production. Staging serves the nightly API."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = "DigitalOcean region, close to the API and the Participants."
  type        = string
  default     = "sgp1"
}

variable "size" {
  description = "Droplet size. Production runs s-2vcpu-2gb; staging stays on s-1vcpu-1gb. Resizing changes CPU and RAM only, never the disk."
  type        = string
  default     = "s-1vcpu-1gb"

  validation {
    condition     = contains(["s-1vcpu-1gb", "s-2vcpu-2gb"], var.size)
    error_message = "size must be s-1vcpu-1gb or s-2vcpu-2gb, the sizes the design budgets for."
  }
}

variable "ssh_key_name" {
  description = "Name of the DigitalOcean SSH key operators deploy with."
  type        = string
  default     = "chalk-sfu-operator"
}

variable "control_addresses" {
  description = "Public addresses, in CIDR form, of the API hosts allowed to reach control on TCP 8443."
  type        = list(string)

  validation {
    condition     = length(var.control_addresses) > 0
    error_message = "control_addresses must name at least one API host."
  }
}

variable "ssh_addresses" {
  description = "Addresses, in CIDR form, allowed to reach SSH. Password login is off; only the operator key works."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "media_port" {
  description = "The one UDP port every peer shares (SFU_UDP_ADDR)."
  type        = number
  default     = 50000
}

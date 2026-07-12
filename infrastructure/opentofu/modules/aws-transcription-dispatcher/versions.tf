terraform {
  # The release workflow runs the OpenTofu version below. Do not apply this
  # module with a different Terraform/OpenTofu implementation against state.
  required_version = "= 1.12.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.90.0"
    }
  }
}

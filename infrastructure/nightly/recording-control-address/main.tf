terraform {
  required_version = "= 1.12.3"
  backend "s3" {
    key          = "recording-control-address/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.90.0"
    }
  }
}

provider "aws" {
  region = "ap-southeast-1"
}

data "aws_ssm_parameter" "release" {
  name            = "/chalk/nightly/release/recorder.json"
  with_decryption = false
}

data "aws_instance" "nightly" {
  instance_id = jsondecode(data.aws_ssm_parameter.release.value).runtime.instance_id

  lifecycle {
    postcondition {
      condition     = self.tags["chalk:environment"] == "nightly"
      error_message = "The recorder address may only be attached to a nightly host."
    }
  }
}

resource "aws_eip" "control" {
  domain = "vpc"
  tags = {
    Name                = "chalk-nightly-recording-control"
    "chalk:environment" = "nightly"
  }

  lifecycle {
    destroy = false
  }
}

resource "aws_eip_association" "control" {
  allocation_id       = aws_eip.control.id
  instance_id         = data.aws_instance.nightly.id
  allow_reassociation = true
}

output "public_ip" {
  value = aws_eip.control.public_ip
}

output "allocation_id" {
  value = aws_eip.control.id
}

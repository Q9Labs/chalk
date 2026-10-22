mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = {
      value = "{\"runtime\":{\"instance_id\":\"i-11111111111111111\"}}"
    }
  }
  mock_data "aws_instance" {
    defaults = {
      id   = "i-11111111111111111"
      tags = { "chalk:environment" = "nightly" }
    }
  }
}

run "first_host" {
  command = plan
  assert {
    condition     = data.aws_instance.nightly.instance_id == "i-11111111111111111" && aws_eip_association.control.instance_id == "i-11111111111111111"
    error_message = "The stable address must attach to the configured nightly target."
  }
}

run "replacement_host" {
  command = plan
  override_data {
    target = data.aws_ssm_parameter.release
    values = {
      value = "{\"runtime\":{\"instance_id\":\"i-22222222222222222\"}}"
    }
  }
  override_data {
    target = data.aws_instance.nightly
    values = {
      id   = "i-22222222222222222"
      tags = { "chalk:environment" = "nightly" }
    }
  }
  assert {
    condition     = data.aws_instance.nightly.instance_id == "i-22222222222222222" && aws_eip_association.control.instance_id == "i-22222222222222222"
    error_message = "The address association must follow a replacement SSM target."
  }
}

run "reject_production_target" {
  command = plan
  override_data {
    target = data.aws_instance.nightly
    values = {
      id   = "i-33333333333333333"
      tags = { "chalk:environment" = "production" }
    }
  }
  expect_failures = [data.aws_instance.nightly]
}

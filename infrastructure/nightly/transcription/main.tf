terraform {
  required_version = "= 1.12.3"
  # Supply only the nightly bucket through -backend-config=backend.hcl.
  # Account IDs and credentials must never be committed.
  backend "s3" {
    key          = "transcription/terraform.tfstate"
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

data "aws_caller_identity" "current" {}

resource "aws_scheduler_schedule_group" "nightly" {
  name = "chalk-nightly"
  tags = { Environment = "nightly" }
}

module "dispatcher" {
  source = "../../opentofu/modules/aws-transcription-dispatcher"

  environment_name                = "nightly"
  function_name                   = "chalk-nightly-transcription-dispatcher"
  scheduler_name                  = "chalk-nightly-transcription-reconcile"
  scheduler_group_name            = aws_scheduler_schedule_group.nightly.name
  scheduler_state                 = var.scheduler_state
  control_api_url                 = "https://nightly-api.chalkmeet.com"
  control_api_audience            = "chalk-nightly-control-api"
  api_workload_auth_parameter_arn = "arn:aws:ssm:ap-southeast-1:${data.aws_caller_identity.current.account_id}:parameter/chalk/nightly/transcription/workload-auth"
  deepinfra_token_parameter_arn   = "arn:aws:ssm:ap-southeast-1:${data.aws_caller_identity.current.account_id}:parameter/chalk/nightly/transcription/deepinfra-token"
  ssm_kms_key_arns                = var.ssm_kms_key_arns

  release_id                 = var.release_id
  release_manifest_digest    = var.release_manifest_digest
  config_digest              = var.config_digest
  artifact_s3_bucket         = "chalk-nightly-artifacts-${data.aws_caller_identity.current.account_id}"
  artifact_s3_key            = var.artifact_s3_key
  artifact_s3_object_version = var.artifact_s3_object_version
  artifact_sha256            = var.artifact_sha256
  artifact_sha256_base64     = var.artifact_sha256_base64

  privacy_gate_accepted              = var.privacy_gate_accepted
  deepinfra_enabled                  = true
  cloudflare_enabled                 = false
  deepinfra_adapter_contract_version = "deepinfra-native-whisper-turbo.v1"
  deepinfra_corpus_digest            = var.deepinfra_corpus_digest
  reserved_concurrency               = 3
  timeout_seconds                    = 600
  work_budget_seconds                = 540
  memory_size                        = 1024
  log_retention_days                 = 14
}

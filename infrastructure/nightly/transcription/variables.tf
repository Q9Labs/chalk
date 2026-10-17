variable "scheduler_state" {
  type    = string
  default = "DISABLED"
  validation {
    condition     = contains(["DISABLED", "ENABLED"], var.scheduler_state)
    error_message = "Enable only after the nightly API and signing proof are healthy."
  }
}
variable "privacy_gate_accepted" {
  type    = bool
  default = false
}
variable "ssm_kms_key_arns" {
  type    = list(string)
  default = []
}
variable "release_id" {
  type = string
}
variable "release_manifest_digest" {
  type = string
}
variable "config_digest" {
  type = string
}
variable "artifact_s3_key" {
  type = string
}
variable "artifact_s3_object_version" {
  type = string
}
variable "artifact_sha256" {
  type = string
}
variable "artifact_sha256_base64" {
  type = string
}
variable "deepinfra_corpus_digest" {
  type = string
}

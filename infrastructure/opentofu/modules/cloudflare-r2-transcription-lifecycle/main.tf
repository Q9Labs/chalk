resource "cloudflare_r2_bucket_lifecycle" "transcription" {
  account_id  = var.account_id
  bucket_name = var.bucket_name

  rules = [
    for prefix in var.temporary_prefixes : {
      id      = "expire-${replace(trim(prefix, "/"), "/", "-")}"
      enabled = true
      conditions = {
        prefix = prefix
      }
      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = var.temporary_expiration_hours * 3600
        }
      }
      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = var.temporary_expiration_hours * 3600
        }
      }
      storage_class_transitions = []
    }
  ]

  lifecycle {
    precondition {
      condition = alltrue([
        for prefix in var.temporary_prefixes : !startswith(var.finalized_transcript_prefix, prefix)
      ])
      error_message = "Temporary lifecycle prefixes must not contain the finalized transcript prefix; committed deletion is application-owned."
    }
  }
}

terraform {
  # Keep the lifecycle module on the same pinned provider line as the release
  # workflow. It manages only the lifecycle document for an existing bucket.
  required_version = "= 1.12.3"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.9.0"
    }
  }
}

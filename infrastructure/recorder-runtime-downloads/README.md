# Recorder runtime downloads

Delivers signed `recorder/<role>/<sha256>.tar.gz` software bundles to recorder
hosts. This is not the user-facing finished-recording download endpoint.
CloudFront fronts a looked-up shared artifacts bucket; the installer verifies
the archive SHA256. Its physical resource names and logical IDs remain unchanged.

**This is a production stack.** The production SSM recorder settings
`CHALK_RECORDER_FLEET_ARCHIVE_CDN_*` point at this CloudFront distribution, so
it is never retired. Alchemy owns it as the `production` stage of
`recorder-runtime-downloads`; `pnpm infra retire recorder-runtime-downloads`
refuses.

## Why the names say nightly and archive

The distribution carries the tag `chalk:environment = nightly`, and the shared
artifacts bucket is `chalk-nightly-artifacts-<account>`. The stack was first
seeded from OpenTofu as `archive-cdn` in the old persistent Nightly stage, and
the names stuck. They serve production. Renaming either one would replace a live
resource: a new bucket would orphan every archive, and a new distribution would
get a new domain that production SSM does not know. So the declaration keeps the
legacy tag as a literal and the bucket name unchanged. Do not rename them in a
structural change; a rename needs its own migration of the bucket, the
distribution and the SSM settings.

## State

The state sits under this stack's own identity, `recorder-runtime-downloads/production`. It was seeded from OpenTofu as `archive-cdn` in the old Nightly stage and moved once. The registry marks the stage seeded, so plan, drift and deploy work on it as on any production Alchemy stack.

`config.ts` validates `{public_key_file}` from `CHALK_INFRA_INPUTS`; provider
credentials follow the shared platform boundary. The existing signing key must
not be rotated as part of this structural change.

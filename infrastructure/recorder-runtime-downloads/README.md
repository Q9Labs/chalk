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

## State move

The state still sits under `archive-cdn/nightly`. The registry marks the stage
"production, state not yet moved", and until the move runs, deploy, plan, drift
and retire refuse. `pnpm infra move-state recorder-runtime-downloads` copies the
five records and the stack output to `recorder-runtime-downloads/production`
under both leases, verifies the copy, then removes the old identity. It is
idempotent, so a retry after a crash finishes the move, and it refuses a
destination that holds different records. Run it with `--dry-run` first. See
[the operator steps](../migration/README.md#recorder-runtime-downloads-state-move).
After it, set `seeded: true` on the registry entry and run `pnpm infra table`.

`config.ts` validates `{public_key_file}` from `CHALK_INFRA_INPUTS`; provider
credentials follow the shared platform boundary. The existing signing key must
not be rotated as part of this structural change.

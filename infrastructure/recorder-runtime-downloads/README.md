# Recorder runtime downloads

Delivers signed `recorder/<role>/<sha256>.tar.gz` software bundles to recorder
hosts. This is not the user-facing finished-recording download endpoint. The
installer on each host verifies the bundle's SHA256, and the host holds no AWS
credentials: the fleet controller hands it a signed CloudFront link.

**This is a production stack**, the `production` stage of
`recorder-runtime-downloads`, and `pnpm infra retire recorder-runtime-downloads`
refuses. It holds one CloudFront distribution per environment, each in front of
that environment's bucket, and one signing key that both trust:

| Distribution (logical ID) | Serves     | Origin                                                 | Why that bucket                                                                                       |
| ------------------------- | ---------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ProductionDownloads`     | Production | `recorder/` in `chalk-production-releases-<account>-…` | Promote copies the exact bundles a production release pins here (`media.py pin_archives`). No expiry. |
| `Archive`                 | Nightly    | `recorder/` in `chalk-nightly-artifacts-<account>`     | Nightly builds publish here first. `recorder/` objects expire after 45 days.                          |

Each environment's `recorder/capture.env` and `recorder/render.env` settings
name its distribution in `CHALK_RECORDER_FLEET_ARCHIVE_CDN_URL`. The key pair ID
and private key are the same for both, so a switch changes only the URL. The
fleet controller reads the URL when a managed release starts it, so a new URL
takes effect with the next release.

A Nightly cleanup can't remove a production bundle: production links resolve
only in the production bucket. The `Archive` distribution, its access control and
the shared key carry their original names (`chalk-recorder-archive`) because
renaming any of them replaces the resource, and a replaced key gets a new ID that
breaks every signed link.

## State

The state sits under `recorder-runtime-downloads/production`. It was first seeded
from OpenTofu as `archive-cdn` in the old Nightly stage and moved once. The stack
owns each bucket's whole policy; the provider overwrites the policy on every
deploy, so add statements here, not in the console.

`config.ts` validates `{public_key_file}` from `CHALK_INFRA_INPUTS`; provider
credentials follow the shared platform boundary. Don't rotate the signing key in
a structural change.

```sh
AWS_PROFILE=q9labs CHALK_INFRA_INPUTS=<private inputs file> pnpm infra plan recorder-runtime-downloads production
```

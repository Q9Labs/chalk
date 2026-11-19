# Recorder archive CDN

CloudFront in front of `recorder/*` in the `chalk-nightly-artifacts-<account>` bucket. The recorder fleet controller signs archive links for it, so a new DigitalOcean recorder node downloads its ~290 MB archive from CloudFront instead of S3 (data transfer out is USD 0.12 per GB from S3; CloudFront's first 1 TB a month is free and its S3 origin fetch costs nothing).

Access is by signed link only (key group). The bucket policy lets only this distribution read `recorder/*` and keeps the TLS-only deny statement. The installer still checks the archive SHA256.

Alchemy owns this stack after the Nightly cutover on 2026-11-19. The original
OpenTofu state and its dated backup remain untouched; the `.tf` and lock files
were removed after verification. Both plans and the deploy were all no-ops,
read-only drift exited zero, and the full live distribution, public key, key
group, origin access control, and bucket policy matched the before capture.

Do not rerun the [migration seed](../README.md#migrate-an-existing-root)
against this already-managed stack. Keep the existing public key for normal
plans and deployments; key rotation is a separate operation.

## Plan and deploy

Set `CHALK_INFRA_INPUTS` to a private JSON file with `public_key_file`, the
absolute path of the existing RSA public key PEM. It replaces OpenTofu's `public_key_pem` input. The private key
stays in the controller's private configuration and never enters this stack.
From the repository root:

```sh
export AWS_PROFILE=q9labs
export CHALK_INFRA_INPUTS=/absolute/path/to/archive-cdn.json
pnpm --dir infrastructure check-types
pnpm --dir infrastructure exec alchemy plan --config archive-cdn/alchemy.run.ts --stage nightly --detailed
pnpm infra deploy archive-cdn nightly
pnpm --dir infrastructure exec alchemy plan --config archive-cdn/alchemy.run.ts --stage nightly --detailed
pnpm --dir infrastructure exec alchemy drift --config archive-cdn/alchemy.run.ts --stage nightly
```

Deploy only after the first plan satisfies the shared migration rules. The
second plan must contain only no-ops, and drift must exit zero without repair.
The stack looks up the existing artifacts bucket without taking ownership of it.
It manages only the bucket policy, preserving the TLS deny and the distribution's
read access to `recorder/*`. The distribution retains HTTPS-only access, the
managed CachingOptimized cache policy, HTTP/2, IPv6, both GET and HEAD, disabled
compression, unrestricted geography, and the default CloudFront certificate.

Outputs keep the names `distribution_url` and `key_pair_id`. Read them without
a deployment:

```sh
pnpm --dir infrastructure exec alchemy state read archive-cdn/nightly/output --config archive-cdn/alchemy.run.ts
```

Capture the distribution ID and domain, public key ID, key group ID, origin
access control ID, and complete bucket policy before and after cutover. Keep the
values private. `--detailed` plans and state reads contain identifiers and public
key material, so do not commit their output.

## Enable on the controller

Add three keys to the SecureString parameters `<parameter_prefix>/recorder/capture.env` and `.../render.env` (for nightly `/chalk/nightly/managed-episode/recorder/`). The controller needs all three or none; a partial set fails at start.

```
CHALK_RECORDER_FLEET_ARCHIVE_CDN_URL=<distribution_url output>
CHALK_RECORDER_FLEET_ARCHIVE_CDN_KEY_PAIR_ID=<key_pair_id output>
CHALK_RECORDER_FLEET_ARCHIVE_CDN_PRIVATE_KEY_BASE64=<base64 of the private key PEM>
```

The values exceed the 4096-character Standard tier limit, so the parameters use the Advanced tier (USD 0.05 a month each). `scripts/releases/media.py pin_archives` keeps unknown keys and the tier, so the next release preserves these.

## Roll back

To undo the infrastructure migration, [delete this stack's Alchemy state records
and restore the previous commit's OpenTofu configuration](../README.md#undo-a-cutover),
using the untouched original state. That operation does not delete live resources.

To disable CDN downloads independently of infrastructure ownership:

Remove the three keys from both parameters; the controller then presigns S3 links as before. Nothing else changes.

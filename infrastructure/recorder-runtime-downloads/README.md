# Recorder runtime downloads

Delivers signed `recorder/<role>/<sha256>.tar.gz` software bundles to recorder
hosts. This is not the user-facing finished-recording download endpoint.
CloudFront fronts a looked-up shared artifacts bucket; the installer verifies
the archive SHA256. Its physical resource names and logical IDs remain unchanged.

The old `archive-cdn/nightly` state is seeded but **retired**, not an active
stage. Current ephemeral proofs do not consume it. The entry deliberately
refuses deployment. See [retirement](../migration/README.md#retire-persistent-nightly-after-merge)
for the guarded future operator commands; they preserve the artifacts bucket,
its objects and unrelated bucket-policy statements.

`config.ts` validates `{public_key_file}` from `CHALK_INFRA_INPUTS`; provider
credentials follow the shared platform boundary. The existing signing key must
not be rotated as part of this structural change.

# Recorder archive CDN

CloudFront in front of `recorder/*` in the `chalk-nightly-artifacts-<account>` bucket. The recorder fleet controller signs archive links for it, so a new DigitalOcean recorder node downloads its ~290 MB archive from CloudFront instead of S3 (data transfer out is USD 0.12 per GB from S3; CloudFront's first 1 TB a month is free and its S3 origin fetch costs nothing).

Access is by signed link only (key group). The bucket policy lets only this distribution read `recorder/*` and keeps the TLS-only deny statement. The installer still checks the archive SHA256.

## Apply

```sh
openssl genrsa -out archive-cdn.pem 2048
openssl rsa -in archive-cdn.pem -pubout -out archive-cdn.pub.pem
cp backend.hcl.example backend.hcl   # set the nightly state bucket
tofu init -backend-config=backend.hcl
tofu apply -var="public_key_pem=$(cat archive-cdn.pub.pem)"
```

## Enable on the controller

Add three keys to the SecureString parameters `<parameter_prefix>/recorder/capture.env` and `.../render.env` (for nightly `/chalk/nightly/managed-episode/recorder/`). The controller needs all three or none; a partial set fails at start.

```
CHALK_RECORDER_FLEET_ARCHIVE_CDN_URL=<distribution_url output>
CHALK_RECORDER_FLEET_ARCHIVE_CDN_KEY_PAIR_ID=<key_pair_id output>
CHALK_RECORDER_FLEET_ARCHIVE_CDN_PRIVATE_KEY_BASE64=<base64 of the private key PEM>
```

The values exceed the 4096-character Standard tier limit, so the parameters use the Advanced tier (USD 0.05 a month each). `scripts/releases/media.py pin_archives` keeps unknown keys and the tier, so the next release preserves these.

## Roll back

Remove the three keys from both parameters; the controller then presigns S3 links as before. Nothing else changes.

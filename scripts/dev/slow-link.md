# Prove recovery through network outages

Run `slow-link.test.mjs` on an isolated Instabox machine. It changes the machine's
IPv4 and IPv6 firewall rules, so do not share the machine with another job.
Install the locked dependencies, Playwright Chromium and its OS dependencies,
plus `iptables`. The caller needs passwordless sudo.

## Nightly

Supply a private JSON file through 1Password. Set `environment` to `nightly` and
include `api_url`, `sync_url`, `tenant_id`, `api_key`, and `proof_origin`.
Only the nightly API and Sync hosts are accepted. `proof_origin` must be an HTTP
`127.0.0.1` origin with an explicit port, already allowed by the synthetic proof
Tenant. Never use a customer Tenant or change access controls for this test.

```sh
CHALK_SLOW_LINK_TARGET=nightly CHALK_SLOW_LINK_CREDENTIALS=/tmp/nightly-proof.json node scripts/dev/slow-link.test.mjs
```

The driver creates its own Space and Episode, disables recording and transcription,
then ends the Episode and archives the Space during cleanup. Delete the credential
file and the disposable machine after collecting evidence.

## Local development

Without `CHALK_SLOW_LINK_TARGET`, the driver starts the local API and Sync stack.
Supply the existing dedicated development SFU configuration through
`CHALK_DEVELOPMENT_CREDENTIALS`. Production is not supported.

## Evidence

The generated JSON report records the SDK checkout revision, connection
transitions, audio RTP statistics, kernel drop counters and per-outage recovery
times. Override the directory with `CHALK_SLOW_LINK_OUTPUT`.

Two Chromium contexts send distinct 439 Hz and 733 Hz microphone tones through the
real SFU. Each received recording should contain the other participant’s tone. After a
45-second slow-link phase, the driver interrupts browser networking and drops
non-DNS UDP plus HTTPS TCP packets in both IP families for 5, 15 and 30 seconds.
SSH remains available. Each outage must stop incoming audio RTP and increment
kernel drop counters. On restoration, both participants must automatically
transition to `live`, with no terminal state or error, and resume fresh inbound
and outbound audio RTP. Receiving Web Audio sinks must report nonzero samples, and decoded audio energy
must also increase.
Two-second local browser recordings preserve each participant’s received audio
after restoration. There is no manual retry path.

Set `CHALK_SLOW_LINK_OUTAGES=30` to rerun a single outage, or supply a comma-separated
selection from 5,15,30. The default runs all three.

Times are milliseconds from the start of network restoration. Audio times include
the three-second sampling window. Keep raw evidence private and out of Git.

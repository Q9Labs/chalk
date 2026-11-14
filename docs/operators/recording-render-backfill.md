# Backfill recording renders

Tenants opt in to automatic rendering with `recording_render_mode: automatic`;
`on_demand` is the default. This command finds older successful captures of
opted-in Tenants and can queue their renders. It never retries a failed job or
renews retention, and a deployment never runs it.

Inject `CHALK_DATABASE_URL` and the `CHALK_R2_*` settings through the operator
environment, never in arguments or logs.

## Inspect, then apply

```sh
(cd apps/api && go run ./cmd/recording-backfill --batch-size 25)
(cd apps/api && go run ./cmd/recording-backfill --batch-size 25 --apply)
```

The default is a dry run on read-only sessions. It checks retention, the capture
key and manifest records, then HEADs every referenced object. A storage error is
reported as unverifiable, not as missing. Apply uses the same render operation as
the API, rechecks eligibility under the Tenant lock and reuses a job created
concurrently, so repeating a batch cannot duplicate a render. Fleet caps, job
deadlines and source expiry still apply.

Start with a small batch and watch renders finish before you continue. Continue
with `--after-recording` set to the report's `next_after_recording`, and keep
that cursor private. If storage could not be verified, rerun the same batch
without moving the cursor. An interrupted apply is safe to repeat.

If a Tenant switches back to `on_demand` or a source expires after the
inventory, the candidate counts as `no_longer_eligible` and no retry is used.
Read or change the mode with `GET` or `PATCH /v1/tenants/{tenant_id}`; the
command never changes it.

Telemetry uses `CHALK_API_OTLP_ENDPOINT`. Without it, trace IDs stay in the
ledger and nothing is exported.

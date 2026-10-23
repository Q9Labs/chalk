# Backfill recording renders

Tenants can opt in to automatic rendering; on demand is the default. This command
inspects older successful captures for opted-in Tenants. It never retries an
existing failed job or renews retention. Deployment never runs this backfill.

Inject `CHALK_DATABASE_URL` and the normal `CHALK_R2_*` configuration through the
operator environment. Do not paste credentials into arguments or logs.
The command uses `CHALK_API_OTLP_ENDPOINT` and `CHALK_API_OTLP_INSECURE` for
the normal telemetry exporter. Each queued job's journey event links to its
backfill span. Without an endpoint, local runs retain trace and span IDs in the
ledger but do not export telemetry.

## Inspect one batch

```sh
bash scripts/recording-backfill.sh --batch-size 25
```

Dry-run is the default and uses read-only database sessions. Each invocation
inspects at most the explicit batch size (1–100), with a 15-minute deadline
(`--timeout` can reduce it or increase it to at most 20 minutes). It checks source
retention, the capture key and manifest records, then HEADs every referenced
bundle, presentation, asset manifest and presentation asset. A missing or empty
object is not recoverable; a storage error is reported as unverifiable, not as
missing. Counts include already queued, expired and missing-source captures.

## Queue a reviewed batch

```sh
bash scripts/recording-backfill.sh --batch-size 25 --apply
```

Apply uses the same canonical render operation as the API, with manual retries
disabled. The transaction
rechecks eligibility and reuses any job created concurrently. Repeating a batch
cannot duplicate a render. The existing fleet cap, job deadlines and source
expiry apply; this command does not change capture admission or fleet settings.

The JSON report includes `next_after_recording`. To continue inventory in UUID
order, pass that value as `--after-recording`. Keep that operator cursor private.
If storage could not be verified, rerun that batch without advancing its cursor.
An interrupted apply can be repeated; no rollback of already queued work is
necessary. Start with a small reviewed batch and observe render completion before
continuing. This command has not been run against production as part of the fix.

## Tenant opt-in

Only Tenants with `recording_render_mode: automatic` appear in the inventory.
The API defaults every existing and new Tenant to `on_demand`; this tool does not change that setting.
`--apply` rechecks the opt-in while locking the Tenant row before inserting a job.
If the Tenant switches back to on demand or the source expires after inventory,
`no_longer_eligible` counts that skipped candidate. No manual retry is consumed.

Read or change the mode with `GET` / `PATCH /v1/tenants/{tenant_id}` using the
existing tenant settings permission (`tenants:write` for scoped callers,
collaborator or owner for members). The Developer dashboard offers the same setting.

# Tenant hard-delete operator command

`pnpm tenant:purge` (`apps/api/cmd/tenant-purge`) erases explicitly approved
Tenant partitions. It is not a dashboard action or an HTTP endpoint. Without
`--apply` it is read-only, and `--dry-run` is the safe default.

Never commit scope files, plans, backups, manifests, results or journals: they
hold production identifiers, credentials or content. Keep them mode `0600` in a
private directory outside Git, and pass secrets through the environment.

## Which operations to use

Use the short operations on managed production: `purge-short`, `cleanup-short`
and `backfill-short`. Managed PostgreSQL wants transactions under about three
seconds ([PlanetScale](https://planetscale.com/docs/postgres/connection-resilience)),
and each short operation stays inside that: a two-second statement timeout, a 200
ms lock timeout and a 2.8 second wall-clock deadline that includes the backup
fsync. The legacy `purge`, `cleanup` and `backfill` run one all-Tenant
transaction and are not for managed production. Run `--help` for flags.

## Approval and backup

1. Write a scope file with `delete` and `keep` arrays of exact `{id, name}`
   identities. They must be disjoint and together match every current Tenant. A
   new, renamed or missing Tenant stops the purge.
2. Inventory with `--operation purge-short --dry-run --scope … --objects …
--plan-out …`. Each object in the reviewed manifest needs `key`, `etag`,
   `size` and an `owner_tenant_id` matching its `tenants/<id>/` prefix. A shared
   object needs an explicit `shared_prefixes` entry and no retained references.
3. Export once with `--export --plan-out …`. Its stdout holds before-images and
   secret values, so pipe it straight into the encrypted backup.
4. Restore-verify in an isolated local database, never production: load the
   exported rows into unconstrained staging tables, `pg_dump` them, restore into a
   fresh database, and check every table count and SHA-256 digest. A readable dump
   is not a verified restore.
5. Back up every object's bytes with size, ETag and SHA-256 checks. Encrypt the
   archive, keep the key in a separate vault, and retain the archive outside Git
   for at least 14 days.
6. Write a backup receipt (`plan_digest`, `archive_path`, `archive_digest`,
   `restore_verified`, `restore_tables`, `completed_at`, `retain_until`). The
   command rechecks the archive digest and rejects unverified or short-lived
   receipts. This is an operator attestation, not a backup service.

## Purge, clean up, backfill

1. Finish migrations, then refresh the plan with `purge-short --dry-run`. The
   approved identities and backed object manifest must match the baseline, though
   other values may have changed.
2. Set `CHALK_TENANT_PURGE_BACKUP_KEY` to the vault's base64 32-byte key. Then run
   `purge-short --apply --tenant-id <id>` once per approved Tenant in ascending
   UUID order, each with its own `--result-out`. Each run locks the Tenant, writes
   an encrypted, fsynced before-image of its live rows, then deletes them. Shared
   users and journey rows wait for the final Tenant, and the final run refuses
   while another approved Tenant remains. A retained membership, incoming
   foreign key, logical link or object reference vetoes erasure.
3. Run `cleanup-short --apply` with the current plan, baseline plan and receipt,
   and a private `--journal`. It deletes objects one at a time, each under its own
   short fence, checking retained references and the backed-up ETag and size.
   Changed bytes stop it. Restarting is safe: it accepts already-absent objects.
4. Run `backfill-short` (inventory, then `--apply`) only with a reviewed backfill
   spec and its own restore-verified baseline. It only raises: selected Spaces at
   disabled/disabled become automatic, Tenant policies raise disabled defaults,
   and deliberate settings, service Spaces and frozen Episode policies are never
   touched.

Keep the shared before-image directory and the original plan when resuming.
Previously committed Tenants are not rolled back when a later one fails. If a run
is interrupted, check that the Tenant is absent, the before-image PKs and the
retained identities before going on, and never replay an unconfirmed commit.
Keep before-images after any rollback, because they also cover unknown commit
outcomes. Keep verified dumps, encrypted before-images and object bytes for at
least 14 days.

## Limits to know

- Storage deletes are not atomic compare-and-delete: R2 ignores `If-Match` on
  DELETE. Other administrators must not write the scoped objects during cleanup.
- Cleanup requires that object-upload permissions and worker leases have expired
  (with a two-minute margin) and all jobs and Episodes are terminal.
- Cloudflare SFU and RTK resources are not erased here. Use their verified
  provider references and the provider's erase APIs. A provider 403 is a
  leftover, not a deletion.
- A database-owner credential is needed because the named append-only Recording
  DELETE guards are suspended inside the fenced transaction and restored before
  commit. Constraints stay enabled and unexpected guards fail closed.
- A retention worker can still complete approved `transcription_cleanup_jobs`
  while you work. `--backup-refresh-command` (purge only) lets a private
  executable build a fresh verified backup under the writer fence. After commit,
  use its refreshed plan and receipt for cleanup, not the superseded ones.

## Restore

Fetch the key from the separate vault, decrypt the archive and verify its hashes.
Restore the subset into an isolated staging database from the columns-only
schema and verify the table digests again. Restore object bytes under their
original keys first. A production relational restore needs a separately reviewed,
foreign-key-aware transaction against the live schema, because nullable cycle
cuts, current webhook revisions and immutable Episode policies need care. Never
load the staging schema into production or overwrite kept rows. Reverse a
backfill from the before-images only if current values still match the recorded
result; otherwise stop for review.

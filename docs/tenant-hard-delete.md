# Tenant hard-delete operator command

This command erases an explicitly approved Tenant partition. It is not a
dashboard action or an HTTP endpoint. **The default and `--dry-run` are read-only.**
Never commit scope, plans, backups, manifests, results or journals: they contain
production identifiers, credentials or content. Keep files mode `0600` inside a
private directory outside Git. Supply runtime secrets through the environment.

## Approval and backup

1. Create `scope.json` with `delete` and `keep` arrays of exact `{id, name}`
   identities. Both are required, disjoint, and together must match every current
   Tenant. New, renamed or missing identities stop the purge.
2. Inventory with `pnpm tenant:purge --scope /private/scope.json --dry-run`.
   Supply `--objects /private/objects.json` for the reviewed object manifest.
   An object must have `key`, `etag`, `size` and an approved `owner_tenant_id`
   matching `tenants/<id>/`. Shared objects need an explicit `shared_prefixes`
   entry and must have no retained references before cleanup.
3. Export once using `--export --plan-out /private/plan.json`. Capture stdout
   directly in the encrypted-backup pipeline: **it includes before-images and
   secret values**, unlike the keys/counts plan. Read-only repeatable-read queries
   choose direct Tenant rows, FK descendants, exclusively owned users and their
   sessions, and related journey events. Incoming retained FK links fail closed.
4. In an isolated local PostgreSQL database, create unconstrained staging tables
   from each table's `columns_ddl`, and load exactly the exported `value` rows.
   Run `pg_dump --format=custom --data-only --no-owner --no-acl` on that subset.
   Dump a separate columns-only staging schema. Restore into a fresh isolated
   database; verify every table count and SHA-256 digest using the exported PK
   order and PostgreSQL JSON representation. Do not treat a readable dump as
   restore verification. Never use a production database for this step.
5. Back up every object's bytes, with size/ETag and SHA-256 checks, plus the
   manifest, dump, staging schema and restoration instructions. Encrypt with
   authenticated encryption, store the key separately in the private vault, and
   retain the encrypted archive outside Git for at least 14 days.
6. Write `backup-receipt.json`: `plan_digest` (SHA-256 of compact Go JSON of the
   keys-only plan), `archive_path`, `archive_digest` (ciphertext SHA-256),
   `restore_verified: true`, `restore_tables` (matching ordered name/count/digest
   entries), `completed_at`, and `retain_until`. The command checks the private
   archive's actual digest and rejects mismatched, unverified or short-lived
   receipts. This is an operator attestation, not an automatic backup service.

## Apply and resume

```
pnpm tenant:purge --apply --plan /private/plan.json \
  --backup-receipt /private/backup-receipt.json --result-out /private/result.json
pnpm tenant:purge --operation cleanup --apply --plan /private/plan.json \
  --backup-receipt /private/backup-receipt.json --journal /private/cleanup.jsonl
```

The relational erase locks public tables against writers, rechecks schema and
row hashes, requires ended Episodes and terminal Recording jobs/reservations,
and reuses Transcript, webhook and user-payload erase helpers. Explicit cycle
cuts and child-first deletes run in **one transaction**. Before commit, every
retained public row must still hash identically. Any unknown FK cycle, drift,
constraint failure or retained mutation rolls everything back. Locks time out
instead of waiting indefinitely.

Use a database-owner operator credential: the product's named append-only
Recording DELETE guards must be suspended inside the fenced transaction and
restored before commit. This does not disable FK/check constraints, rewrite
functions or persist a schema change. Trigger definitions/function hashes are
part of the approved schema digest; unexpected guards fail closed.

Cleanup is a separate repeatable operation. It requires deleted Tenants to be
absent, scans all remaining rows for object/shared-namespace references, and
fences SQL writers during deletion. R2 ignores DELETE If-Match (verified with an isolated operator-owned probe).
Before relational erase, persisted object-upload permissions and worker leases
must have expired, with a two-minute drain margin, and all jobs/Episodes must be
terminal. Removing the Tenant prevents new permissions. Cleanup checks backed-up
ETags/sizes before ordinary deletes under the retained-reference writer fence;
this is not atomic storage compare-and-delete. Other administrators must not
write these scoped objects during the cleanup window. Changed bytes stop cleanup. Each
confirmed absence is fsynced to the private journal. Restarting cleanup safely
accepts already-absent objects. Keep the original approved plan and backup.
Cloudflare SFU/RTK resources are not guessed from historical demo identifiers;
use their verified provider references and supported provider erase APIs
separately. A provider 403 is a leftover, not proof of deletion.

If interrupted, the reserved result file says to inspect the database. Determine
whether the relational transaction committed before retrying. A successful
relational purge is not replayed: its deleted identities are now absent.

## Raise-only backfill

Use `--operation backfill --backfill /private/backfill.json` to inventory and
export a separate backed-up plan. The spec contains `service_tenant_ids` and
explicit `spaces: [{id, tenant_id}]`. Service Spaces are rejected. Only selected
Spaces still at disabled/disabled become automatic/on-demand. Deliberate and
automatic settings are not discovered or lowered. Kept Tenant policies raise
disabled ceilings/defaults to on-demand, retaining automatic values and custom
retentions; the required provider version/source window are repaired only when
empty/zero. Frozen Episode policies are untouched. Apply with its own plan,
backup receipt and result file; it is one guarded transaction.

## Restore

Recover the archive key from the separate vault, authenticate/decrypt the
archive, and verify its plaintext manifest hashes. Restore the subset dump into
an isolated staging database using the included columns-only schema. Verify the
table digests again before any production restore. Restore object bytes under
their original keys first. Production relational restoration needs a separately
reviewed FK-aware transaction against the current live schema (nullable cycle
cuts/current webhook revisions and immutable Episode policies require care).
Never load the staging schema into production or overwrite kept rows. Backfill
reversal uses the backed-up before-images only if current values still match
the recorded backfill result; otherwise stop for review.

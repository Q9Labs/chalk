# Tenant hard-delete operator command

This command erases an explicitly approved Tenant partition. It is not a
dashboard action or an HTTP endpoint. **The default and `--dry-run` are read-only.**
Never commit scope, plans, backups, manifests, results or journals: they contain
production identifiers, credentials or content. Keep files mode `0600` inside a
private directory outside Git. Supply runtime secrets through the environment.

## Short transactions on managed PostgreSQL

Use `purge-short`, `cleanup-short` and `backfill-short` for managed production.
[PlanetScale recommends transactions under three seconds](https://planetscale.com/docs/postgres/connection-resilience).
The older all-Tenant transaction below is not suitable for that window.

Inventory with `--operation purge-short --dry-run --scope /private/scope.json
--objects /private/objects.json --plan-out /private/current-plan.json`.
These are autocommit reads, not a long repeatable-read transaction. Finish
migrations first, then refresh the schema. Preserve the restore-verified baseline
dump/object archive and its original plan/receipt; baseline values may have
changed, but the approved identities and backed object manifest must not.

Set `CHALK_TENANT_PURGE_BACKUP_KEY` to the separate vault's base64 32-byte key.
Create an owner-only directory outside Git, resolving any parent symlinks.
For each approved Tenant in ascending UUID order, run:

```
pnpm tenant:purge --operation purge-short --apply --tenant-id <approved-id> \
  --plan /private/current-plan.json --baseline-plan /private/baseline-plan.json \
  --backup-receipt /private/baseline-receipt.json \
  --before-images-directory /private/encrypted-backups \
  --result-out /private/unique-tenant-result.json
```

Each invocation takes a Tenant advisory lock and brief table writer fences,
materializes live rows with `FOR UPDATE`, encrypts and fsyncs their exact
before-images and directory, then deletes those PKs. Statement timeout is two
seconds, lock timeout 200ms and wall-clock transaction deadline 2.8 seconds,
including backup fsync. No pg_dump/restore or subprocess runs inside the fence.
Shared users and global journey rows wait for the final approved Tenant; the
final invocation refuses while another approved Tenant remains. The shared before-image directory carries authenticated live account/journey
identities from earlier commits, including new bookkeeping, into the final
selection. Keep that directory and the original plan when resuming. Kept
memberships, incoming FK/logical links and object references still veto erasure.
Bookkeeping drift is captured, not compared with stale snapshot hashes.
The object reference check fences each validated Tenant/shared namespace once,
including bare namespace references, rather than comparing hundreds of keys
against every retained JSON row. This stronger fence also holds unlisted keys
inside an approved namespace; lookalike sibling namespaces do not match.

The full object-reference scan runs as one autocommit SELECT before taking the
writer fence. Its MVCC oldest-active cutoff covers subsequent inserts/updates,
including already in-flight subtransactions; those rows are rescanned under the
fence. User/logical ownership-dependent rows are always rescanned because their
ownership can change without updating the child. The optimized cutoff refuses
transaction-ID epochs beyond zero rather than misreading wrapped IDs. Cleanup
uses one full scan, then a new delta fence for every object.

This path reuses the hard-delete catalog, cycle cuts, known append-only guards,
delete ordering and storage erase helper. It does not generate the soft-delete
helpers' additional audit/cleanup rows. Every table's count difference must equal
its backed count, and every unselected row must retain its exact `tableoid`/`xmin`/`ctid`
version digest under the writer fence. An UPDATE creates a new tuple version;
the fence excludes vacuum/rewrite too. This detects even same-value UPDATEs
without repeatedly serializing large monitoring payloads. See PostgreSQL's
[system columns](https://www.postgresql.org/docs/current/ddl-system-columns.html)
and [snapshot functions](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-PG-SNAPSHOT).
Constraints stay enabled; suspended guards must be restored before commit.

Each encrypted file has `CHALKTPB1` magic, 12-byte nonce, then AES-256-GCM
ciphertext/tag with the magic as associated data. An fsynced sibling receipt
records ciphertext/plaintext hashes and at least 14 days' retention. Do not
delete before-images after rollback: they also support unknown commit outcomes.
If interrupted, inspect target absence, before-image PKs and retained identities
before proceeding; never blindly replay an unconfirmed commit. Previously
committed Tenants are not rolled back because a later Tenant fails.

After all relational commits, use `cleanup-short` with the current purge plan,
baseline plan/receipt and private journal. It checks each object's retained
references under its own short fence, reusing the idempotent inspect/delete/HEAD
helper. The deadline includes the external call; no transaction spans the whole
manifest. Then inventory/apply `backfill-short` with the explicit backfill spec,
matching backfill baseline and before-image directory. It remains one short,
raise-only transaction with service Spaces and deliberate values protected.

Outside all production transactions, authenticate each live before-image,
materialize exactly its rows in an isolated PostgreSQL staging database, dump
and restore-verify them using the procedure below. Keep these verified dumps,
the encrypted live authority files and object bytes at least 14 days.

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

### A retention worker still completing approved cleanup jobs

Use `--backup-refresh-command /absolute/private/executable` only with `--apply`
for purge. It does not bypass the existing encrypted, restore-verified backup.
Tenant identities, schema, row counts, row keys and every other table's bytes
must still match. Only existing approved `transcription_cleanup_jobs` values
may refresh. The operator holds its writer fence and sends full fresh
before-images to the executable's stdin, never ordinary logs. The executable
must encrypt a fresh full affected-row subset, `pg_dump`/restore-verify it,
preserve the verified object-byte backup, and return a matching `BackupReceipt`
JSON on stdout. Its new private plan must use `WithoutValues` row-key format
and preserve the exact object manifest for subsequent cleanup.

Production SQL credentials are removed from the child environment. No row
erasure begins unless its receipt, table hashes, 14-day retention and actual
encrypted archive SHA pass. Backup failure rolls back; the fence remains held
through backup verification and erase. The backup executable owns its isolated
restore-cluster cleanup, including interruption handling. After commit, use
its refreshed private plan/receipt for storage cleanup, not the superseded plan.

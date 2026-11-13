package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type purgeBackupRefresh func(context.Context, tenantpurge.Plan) (tenantpurge.BackupReceipt, error)

func (r TenantPurgeRepository) Apply(ctx context.Context, expected tenantpurge.Plan, receipt tenantpurge.BackupReceipt) (tenantpurge.Plan, error) {
	return r.apply(ctx, expected, receipt, nil)
}

// ApplyWithFrozenBackup refreshes only existing cleanup-job before-images
// while the transaction fences writers. The callback must restore-verify the
// full affected subset before returning its matching encrypted-backup receipt.
func (r TenantPurgeRepository) ApplyWithFrozenBackup(ctx context.Context, expected tenantpurge.Plan, receipt tenantpurge.BackupReceipt, refresh purgeBackupRefresh) (tenantpurge.Plan, error) {
	if refresh == nil {
		return tenantpurge.Plan{}, errors.New("frozen backup callback required")
	}
	return r.apply(ctx, expected, receipt, refresh)
}

func (r TenantPurgeRepository) apply(ctx context.Context, expected tenantpurge.Plan, receipt tenantpurge.BackupReceipt, refresh purgeBackupRefresh) (tenantpurge.Plan, error) {
	if expected.Kind != "purge" {
		return tenantpurge.Plan{}, errors.New("not a purge plan")
	}
	if err := receipt.Validate(expected, time.Now().UTC()); err != nil {
		return tenantpurge.Plan{}, err
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer tx.Rollback(ctx)
	catalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	if err := lockPurgeTables(ctx, tx, catalog); err != nil {
		return tenantpurge.Plan{}, err
	}
	current, _, selected, err := snapshotPurge(ctx, tx, expected.Scope, refresh != nil)
	if err != nil {
		return current, err
	}
	if err := erasePurge(ctx, tx, catalog, selected, expected, &current, refresh); err != nil {
		return current, err
	}
	if err := tx.Commit(ctx); err != nil {
		return current, err
	}
	return current, nil
}

// erasePurge checks the snapshot against the expected plan, deletes the selected rows and proves that
// nothing else changed. Any error rolls the transaction back.
func erasePurge(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, selected map[string]string, expected tenantpurge.Plan, current *tenantpurge.Plan, refresh purgeBackupRefresh) error {
	compare := tenantpurge.SameRows
	if refresh != nil {
		compare = tenantpurge.SameRowsForFrozenBackup
	}
	if err := compare(expected, *current); err != nil {
		return err
	}
	if err := current.WriteDrain.Validate(time.Now().UTC()); err != nil {
		return err
	}
	ids := purgeIDs(expected.Scope)
	if err := requirePurgeDrained(ctx, tx, ids); err != nil {
		return err
	}
	protected, err := protectedPurgeDigests(ctx, tx, catalog, selected, ids)
	if err != nil {
		return err
	}
	if err := checkExpectedObjects(ctx, tx, catalog, selected, ids, expected); err != nil {
		return err
	}
	if refresh != nil {
		if err := refreshFrozenBackup(ctx, refresh, current, expected); err != nil {
			return err
		}
	}
	if err := eraseUserPayloads(ctx, tx, *current); err != nil {
		return err
	}
	if err := reusePurgeEraseHelpers(ctx, tx, ids); err != nil {
		return err
	}
	temp, names, err := materializePurge(ctx, tx, catalog, selected, ids)
	if err != nil {
		return err
	}
	// Re-check helpers did not mutate or newly select any retained data.
	postHelpers, err := protectedPurgeDigests(ctx, tx, catalog, selected, ids)
	if err != nil {
		return err
	}
	if name, changed := changedDigest(protected, postHelpers); changed {
		return fmt.Errorf("erase helper changed retained rows in %s", name)
	}
	run := purgeRun{tx: tx, catalog: catalog, selected: selected, protected: protected}
	return run.deleteMaterialized(ctx, temp, names, ids, current.SchemaDigest)
}

// purgeRun holds what the delete phase needs from the checks before it.
type purgeRun struct {
	tx        pgx.Tx
	catalog   purgeCatalog
	selected  map[string]string
	protected map[string]string
}

func requirePurgeDrained(ctx context.Context, tx pgx.Tx, ids []string) error {
	for _, check := range []string{
		`select count(*) from public.episodes where tenant_id=any($1::uuid[]) and status<>'ended'`,
		`select count(*) from public.recording_jobs where tenant_id=any($1::uuid[]) and state not in ('succeeded','terminal_failure','cancelled')`,
		`select count(*) from public.recording_reservations where tenant_id=any($1::uuid[]) and state not in ('released','expired')`,
	} {
		var count int64
		if err := tx.QueryRow(ctx, check, ids).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("active Episodes, Recording jobs or reservations must drain before erase")
		}
	}
	return nil
}

func checkExpectedObjects(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, selected map[string]string, ids []string, expected tenantpurge.Plan) error {
	if expected.Objects == nil {
		return nil
	}
	if err := expected.Objects.Validate(expected.Scope); err != nil {
		return err
	}
	return checkRetainedObjectReferences(ctx, tx, catalog, selected, ids, *expected.Objects)
}

func refreshFrozenBackup(ctx context.Context, refresh purgeBackupRefresh, current *tenantpurge.Plan, expected tenantpurge.Plan) error {
	current.Objects = expected.Objects
	fresh, err := refresh(ctx, *current)
	if err != nil {
		return fmt.Errorf("frozen backup: %w", err)
	}
	return fresh.Validate(*current, time.Now().UTC())
}

// eraseUserPayloads must run before membership and user links disappear.
func eraseUserPayloads(ctx context.Context, tx pgx.Tx, current tenantpurge.Plan) error {
	for _, table := range current.Tables {
		if table.Name != "users" {
			continue
		}
		for _, row := range table.Rows {
			var key struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(row.Key, &key); err != nil {
				return err
			}
			id, err := utilities.ParseID(key.ID)
			if err != nil {
				return err
			}
			if _, err := eraseUserWebhookEventsTx(ctx, tx, id); err != nil {
				return err
			}
		}
	}
	return nil
}

func (run purgeRun) deleteMaterialized(ctx context.Context, temp map[string]string, names, ids []string, schemaDigest string) error {
	if err := cutPurgeCycles(ctx, run.tx, ids); err != nil {
		return err
	}
	order, err := tenantpurge.DeleteOrder(purgeDeleteTables(names), purgeParents(run.catalog))
	if err != nil {
		return err
	}
	suspended, err := suspendPurgeGuards(ctx, run.tx, run.catalog, run.selected)
	if err != nil {
		return err
	}
	if err := deletePurgeRows(ctx, run.tx, run.catalog, order, temp); err != nil {
		return err
	}
	if err := checkNoResidualPurgeRows(ctx, run.tx, run.catalog, temp); err != nil {
		return err
	}
	remaining, err := retainedPurgeDigests(ctx, run.tx, run.catalog)
	if err != nil {
		return err
	}
	if name, changed := changedDigest(run.protected, remaining); changed {
		return fmt.Errorf("retained rows changed in %s; purge rolled back", name)
	}
	if err := restorePurgeGuards(ctx, run.tx, suspended); err != nil {
		return err
	}
	return checkPurgeGuardsRestored(ctx, run.tx, schemaDigest)
}

func cutPurgeCycles(ctx context.Context, tx pgx.Tx, ids []string) error {
	for _, cut := range []string{
		`update public.sync_external_operations set applied_event_id=null,applied_revision=null where tenant_id=any($1::uuid[])`,
		`update public.recording_capture_connections set active_command_id=null,active_execution_token=null,active_execution_expires_at=null where tenant_id=any($1::uuid[])`,
	} {
		if _, err := tx.Exec(ctx, cut, ids); err != nil {
			return err
		}
	}
	return nil
}

// purgeParents lists, per table, the tables its rows reference, without the three foreign keys that
// form cycles which the cut statements above break.
func purgeParents(catalog purgeCatalog) map[string][]string {
	parents := make(map[string][]string)
	for _, fk := range catalog.FKs {
		switch {
		case fk.Child == "webhook_endpoints" && fk.Parent == "webhook_endpoint_revisions",
			fk.Child == "sync_external_operations" && fk.Parent == "sync_control_events",
			fk.Child == "recording_capture_connections" && fk.Parent == "recording_capture_commands":
			continue
		}
		parents[fk.Child] = append(parents[fk.Child], fk.Parent)
	}
	return parents
}

// purgeDeleteTables drops the revision table: the required current revision goes with the endpoint's
// own cascade.
func purgeDeleteTables(names []string) []string {
	filtered := make([]string, 0, len(names))
	for _, name := range names {
		if name != "webhook_endpoint_revisions" {
			filtered = append(filtered, name)
		}
	}
	return filtered
}

func deletePurgeRows(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, order []string, temp map[string]string) error {
	for _, name := range order {
		table, ok := catalog.table(name)
		if !ok {
			return errors.New("unknown delete table")
		}
		if _, err := tx.Exec(ctx, `delete from `+purgeName(name)+` d using `+temp[name]+` s where `+purgePKJoin(table, "d", "s")); err != nil {
			return fmt.Errorf("erase %s: %w", name, err)
		}
	}
	return nil
}

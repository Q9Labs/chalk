package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TenantPurgeRepository struct{ pool *pgxpool.Pool }

func NewTenantPurgeRepository(pool *pgxpool.Pool) TenantPurgeRepository {
	return TenantPurgeRepository{pool: pool}
}

func reusePurgeEraseHelpers(ctx context.Context, tx pgx.Tx, ids []string) error {
	rows, err := tx.Query(ctx, `select tenant_id::text,id::text from public.transcriptions where tenant_id=any($1::uuid[]) and deleted_at is null order by id`, ids)
	if err != nil {
		return err
	}
	var transcripts []struct{ Tenant, ID string }
	for rows.Next() {
		var value struct{ Tenant, ID string }
		if err := rows.Scan(&value.Tenant, &value.ID); err != nil {
			rows.Close()
			return err
		}
		transcripts = append(transcripts, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, value := range transcripts {
		tenantID, err := utilities.ParseID(value.Tenant)
		if err != nil {
			return err
		}
		id, err := utilities.ParseID(value.ID)
		if err != nil {
			return err
		}
		if _, err := deleteTranscriptTx(ctx, tx, tenantID, id); err != nil {
			return err
		}
	}
	rows, err = tx.Query(ctx, `select tenant_id::text,id::text,revision from public.webhook_endpoints where tenant_id=any($1::uuid[]) and deleted_at is null order by id`, ids)
	if err != nil {
		return err
	}
	var endpoints []struct {
		Tenant, ID string
		Revision   int
	}
	for rows.Next() {
		var value struct {
			Tenant, ID string
			Revision   int
		}
		if err := rows.Scan(&value.Tenant, &value.ID, &value.Revision); err != nil {
			rows.Close()
			return err
		}
		endpoints = append(endpoints, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, value := range endpoints {
		tenantID, err := utilities.ParseID(value.Tenant)
		if err != nil {
			return err
		}
		id, err := utilities.ParseID(value.ID)
		if err != nil {
			return err
		}
		if _, err := eraseWebhookEndpointTx(ctx, tx, tenantID, id, value.Revision); err != nil {
			return err
		}
	}
	return nil
}

func materializePurge(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, selected map[string]string, ids []string) (map[string]string, []string, error) {
	temp := make(map[string]string)
	var nonempty []string
	for _, table := range catalog.Tables {
		condition := selected[table.Name]
		if condition == "" {
			continue
		}
		name := pgx.Identifier{"pg_temp", "chalk_purge_" + table.Name}.Sanitize()
		_, err := tx.Exec(ctx, `create temporary table `+name+` on commit drop as select * from `+purgeName(table.Name)+` where `+condition, ids)
		if err != nil {
			return nil, nil, fmt.Errorf("materialize %s: %w", table.Name, err)
		}
		temp[table.Name] = name
		var count int64
		if err := tx.QueryRow(ctx, `select count(*) from `+name).Scan(&count); err != nil {
			return nil, nil, err
		}
		if count > 0 {
			nonempty = append(nonempty, table.Name)
		}
	}
	return temp, nonempty, nil
}

func purgePKJoin(table purgeTable, a, b string) string {
	var parts []string
	for _, key := range table.Primary {
		parts = append(parts, pgx.Identifier{a, key}.Sanitize()+"="+pgx.Identifier{b, key}.Sanitize())
	}
	return strings.Join(parts, " and ")
}

func (r TenantPurgeRepository) Apply(ctx context.Context, expected tenantpurge.Plan, receipt tenantpurge.BackupReceipt) (tenantpurge.Plan, error) {
	return r.apply(ctx, expected, receipt, nil)
}

// ApplyWithFrozenBackup refreshes only existing cleanup-job before-images
// while the transaction fences writers. The callback must restore-verify the
// full affected subset before returning its matching encrypted-backup receipt.
func (r TenantPurgeRepository) ApplyWithFrozenBackup(ctx context.Context, expected tenantpurge.Plan, receipt tenantpurge.BackupReceipt, refresh func(context.Context, tenantpurge.Plan) (tenantpurge.BackupReceipt, error)) (tenantpurge.Plan, error) {
	if refresh == nil {
		return tenantpurge.Plan{}, errors.New("frozen backup callback required")
	}
	return r.apply(ctx, expected, receipt, refresh)
}

func (r TenantPurgeRepository) apply(ctx context.Context, expected tenantpurge.Plan, receipt tenantpurge.BackupReceipt, refresh func(context.Context, tenantpurge.Plan) (tenantpurge.BackupReceipt, error)) (tenantpurge.Plan, error) {
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
	compare := tenantpurge.SameRows
	if refresh != nil {
		compare = tenantpurge.SameRowsForFrozenBackup
	}
	if err := compare(expected, current); err != nil {
		return current, err
	}
	if err := current.WriteDrain.Validate(time.Now().UTC()); err != nil {
		return current, err
	}
	ids := purgeIDs(expected.Scope)
	for _, check := range []string{
		`select count(*) from public.episodes where tenant_id=any($1::uuid[]) and status<>'ended'`,
		`select count(*) from public.recording_jobs where tenant_id=any($1::uuid[]) and state not in ('succeeded','terminal_failure','cancelled')`,
		`select count(*) from public.recording_reservations where tenant_id=any($1::uuid[]) and state not in ('released','expired')`,
	} {
		var count int64
		if err := tx.QueryRow(ctx, check, ids).Scan(&count); err != nil {
			return current, err
		}
		if count != 0 {
			return current, errors.New("active Episodes, Recording jobs or reservations must drain before erase")
		}
	}
	protected, err := protectedPurgeDigests(ctx, tx, catalog, selected, ids)
	if err != nil {
		return current, err
	}
	if expected.Objects != nil {
		if err := expected.Objects.Validate(expected.Scope); err != nil {
			return current, err
		}
		if err := checkRetainedObjectReferences(ctx, tx, catalog, selected, ids, *expected.Objects); err != nil {
			return current, err
		}
	}
	if refresh != nil {
		current.Objects = expected.Objects
		fresh, err := refresh(ctx, current)
		if err != nil {
			return current, fmt.Errorf("frozen backup: %w", err)
		}
		if err := fresh.Validate(current, time.Now().UTC()); err != nil {
			return current, err
		}
	}
	// User payload erasure must happen before membership/user links disappear.
	for _, table := range current.Tables {
		if table.Name != "users" {
			continue
		}
		for _, row := range table.Rows {
			var key struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(row.Key, &key); err != nil {
				return current, err
			}
			id, err := utilities.ParseID(key.ID)
			if err != nil {
				return current, err
			}
			if _, err := eraseUserWebhookEventsTx(ctx, tx, id); err != nil {
				return current, err
			}
		}
	}
	if err := reusePurgeEraseHelpers(ctx, tx, ids); err != nil {
		return current, err
	}
	temp, names, err := materializePurge(ctx, tx, catalog, selected, ids)
	if err != nil {
		return current, err
	}
	// Re-check helpers did not mutate or newly select any retained data.
	postHelpers, err := protectedPurgeDigests(ctx, tx, catalog, selected, ids)
	if err != nil {
		return current, err
	}
	for name, digest := range protected {
		if postHelpers[name] != digest {
			return current, fmt.Errorf("erase helper changed retained rows in %s", name)
		}
	}
	for _, cut := range []string{
		`update public.sync_external_operations set applied_event_id=null,applied_revision=null where tenant_id=any($1::uuid[])`,
		`update public.recording_capture_connections set active_command_id=null,active_execution_token=null,active_execution_expires_at=null where tenant_id=any($1::uuid[])`,
	} {
		if _, err := tx.Exec(ctx, cut, ids); err != nil {
			return current, err
		}
	}
	parents := make(map[string][]string)
	for _, fk := range catalog.FKs {
		if fk.Child == "webhook_endpoints" && fk.Parent == "webhook_endpoint_revisions" {
			continue
		}
		if fk.Child == "sync_external_operations" && fk.Parent == "sync_control_events" {
			continue
		}
		if fk.Child == "recording_capture_connections" && fk.Parent == "recording_capture_commands" {
			continue
		}
		parents[fk.Child] = append(parents[fk.Child], fk.Parent)
	}
	// The required current revision is removed by the endpoint's own cascade.
	filtered := names[:0]
	for _, name := range names {
		if name != "webhook_endpoint_revisions" {
			filtered = append(filtered, name)
		}
	}
	order, err := tenantpurge.DeleteOrder(filtered, parents)
	if err != nil {
		return current, err
	}
	suspended, err := suspendPurgeGuards(ctx, tx, catalog, selected)
	if err != nil {
		return current, err
	}
	for _, name := range order {
		table, ok := catalog.table(name)
		if !ok {
			return current, errors.New("unknown delete table")
		}
		if _, err := tx.Exec(ctx, `delete from `+purgeName(name)+` d using `+temp[name]+` s where `+purgePKJoin(table, "d", "s")); err != nil {
			return current, fmt.Errorf("erase %s: %w", name, err)
		}
	}
	// Stable PK scopes survive deletion of their parents and memberships.
	for name, source := range temp {
		table, _ := catalog.table(name)
		var residual int64
		if err := tx.QueryRow(ctx, `select count(*) from `+purgeName(name)+` d join `+source+` s on `+purgePKJoin(table, "d", "s")).Scan(&residual); err != nil {
			return current, err
		}
		if residual != 0 {
			return current, fmt.Errorf("residual approved rows in %s", name)
		}
	}
	// All remaining public rows must match the retained pre-erase projection.
	remaining := make(map[string]string)
	for _, table := range catalog.Tables {
		query := `select to_jsonb(r)::text from ` + purgeName(table.Name) + ` r order by to_jsonb(r)::text`
		rows, err := tx.Query(ctx, query)
		if err != nil {
			return current, err
		}
		hash := sha256.New()
		for rows.Next() {
			var value string
			if err := rows.Scan(&value); err != nil {
				rows.Close()
				return current, err
			}
			hash.Write([]byte(value + "\n"))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return current, err
		}
		rows.Close()
		remaining[table.Name] = hex.EncodeToString(hash.Sum(nil))
	}
	for name, digest := range protected {
		if remaining[name] != digest {
			return current, fmt.Errorf("retained rows changed in %s; purge rolled back", name)
		}
	}
	if err := restorePurgeGuards(ctx, tx, suspended); err != nil {
		return current, err
	}
	restoredCatalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return current, err
	}
	restoredDigest, err := restoredCatalog.digest()
	if err != nil {
		return current, err
	}
	if restoredDigest != current.SchemaDigest {
		return current, errors.New("purge guard schema was not restored")
	}
	if err := tx.Commit(ctx); err != nil {
		return current, err
	}
	return current, nil
}

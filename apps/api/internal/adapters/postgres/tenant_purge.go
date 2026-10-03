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

func readPurgeTable(ctx context.Context, tx pgx.Tx, table purgeTable, condition string, ids []string, values bool) (tenantpurge.Table, error) {
	result := tenantpurge.Table{Name: table.Name, Digest: tenantpurge.Digest(nil)}
	var ddl []string
	for _, column := range table.Columns {
		ddl = append(ddl, purgeQuote(column.Name)+" "+column.Type)
	}
	result.ColumnsDDL = strings.Join(ddl, ",")
	if condition == "" {
		return result, nil
	}
	if len(table.Primary) == 0 {
		return result, fmt.Errorf("selected table %s has no primary key", table.Name)
	}
	key := primaryExpression(table, "r")
	query := `select (` + key + `)::text,to_jsonb(r)::text from (select * from ` + purgeName(table.Name) + ` where ` + condition + `) r order by (` + key + `)::text`
	rows, err := tx.Query(ctx, query, ids)
	if err != nil {
		return result, fmt.Errorf("snapshot %s: %w", table.Name, err)
	}
	defer rows.Close()
	hash := sha256.New()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return result, err
		}
		hash.Write([]byte(key + "\n" + value + "\n"))
		result.Count++
		row := tenantpurge.Row{Key: json.RawMessage(key)}
		if values {
			row.Value = json.RawMessage(value)
		}
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	result.Digest = hex.EncodeToString(hash.Sum(nil))
	return result, nil
}

func snapshotPurge(ctx context.Context, tx pgx.Tx, scope tenantpurge.Scope, values bool) (tenantpurge.Plan, purgeCatalog, map[string]string, error) {
	plan := tenantpurge.Plan{Version: 1, Kind: "purge", CreatedAt: time.Now().UTC(), Scope: scope}
	if err := checkPurgeScope(ctx, tx, scope, true); err != nil {
		return plan, purgeCatalog{}, nil, err
	}
	catalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return plan, catalog, nil, err
	}
	plan.SchemaDigest, err = catalog.digest()
	if err != nil {
		return plan, catalog, nil, err
	}
	selected, err := catalog.predicates()
	if err != nil {
		return plan, catalog, nil, err
	}
	ids := purgeIDs(scope)
	if err := checkPurgeBoundaries(ctx, tx, catalog, selected, ids); err != nil {
		return plan, catalog, nil, err
	}
	for _, table := range catalog.Tables {
		data, err := readPurgeTable(ctx, tx, table, selected[table.Name], ids, values)
		if err != nil {
			return plan, catalog, nil, err
		}
		plan.Tables = append(plan.Tables, data)
	}
	plan.WriteDrain, err = snapshotPurgeWriteDrain(ctx, tx, catalog, selected, ids)
	if err != nil {
		return plan, catalog, selected, err
	}
	return plan, catalog, selected, nil
}

func (r TenantPurgeRepository) Snapshot(ctx context.Context, scope tenantpurge.Scope, values bool) (tenantpurge.Plan, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `set local timezone='UTC';set local statement_timeout='120s';set local lock_timeout='2s'`); err != nil {
		return tenantpurge.Plan{}, err
	}
	plan, _, _, err := snapshotPurge(ctx, tx, scope, values)
	if err != nil {
		return plan, err
	}
	return plan, tx.Commit(ctx)
}

func lockPurgeTables(ctx context.Context, tx pgx.Tx, catalog purgeCatalog) error {
	var names []string
	for _, table := range catalog.Tables {
		names = append(names, purgeName(table.Name))
	}
	if _, err := tx.Exec(ctx, `set local timezone='UTC';set local statement_timeout='120s';set local lock_timeout='5s'`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(734091287)`); err != nil {
		return err
	}
	// This short operator window fences SQL writers, including callbacks and
	// all FK descendants. It changes no retained row and is not a fleet pause.
	_, err := tx.Exec(ctx, `lock table `+strings.Join(names, ",")+` in share row exclusive mode`)
	return err
}

func protectedPurgeDigests(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, selected map[string]string, ids []string) (map[string]string, error) {
	digests := make(map[string]string)
	for _, table := range catalog.Tables {
		condition := selected[table.Name]
		if condition == "" {
			condition = "false"
		}
		query := `select to_jsonb(r)::text from (select * from ` + purgeName(table.Name) + ` where not coalesce((` + condition + `),false) and cardinality($1::uuid[])>=0) r order by to_jsonb(r)::text`
		rows, err := tx.Query(ctx, query, ids)
		if err != nil {
			return nil, err
		}
		hash := sha256.New()
		for rows.Next() {
			var value string
			if err := rows.Scan(&value); err != nil {
				rows.Close()
				return nil, err
			}
			hash.Write([]byte(value + "\n"))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		digests[table.Name] = hex.EncodeToString(hash.Sum(nil))
	}
	return digests, nil
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
	current, _, selected, err := snapshotPurge(ctx, tx, expected.Scope, false)
	if err != nil {
		return current, err
	}
	if err := tenantpurge.SameRows(expected, current); err != nil {
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

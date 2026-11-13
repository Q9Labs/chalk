package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

// ApplyTenantShort ignores snapshot value/count drift. Live materialized rows
// are backed up and fsynced before exact-PK erase; all unselected rows and
// cross-tenant/logical/object references remain fail-closed.
func (r TenantPurgeRepository) ApplyTenantShort(ctx context.Context, expected tenantpurge.Plan, target string, backup func(context.Context, tenantpurge.Plan) error) (tenantpurge.Plan, error) {
	if expected.Kind != "purge" || backup == nil || !slices.Contains(purgeIDs(expected.Scope), target) {
		return tenantpurge.Plan{}, errors.New("approved Tenant and encrypted backup sink required")
	}
	if expected.Objects != nil {
		if err := expected.Objects.Validate(expected.Scope); err != nil {
			return tenantpurge.Plan{}, err
		}
	}
	catalog, fingerprint, err := r.shortCatalog(ctx, expected)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	selected, retained, err := shortPredicates(catalog, expected, target)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	return r.shortChange(ctx, expected, target, catalog, fingerprint, selected, retained, backup, true)
}

// shortRun is one fenced short purge or backfill: one select batch, a backup, then one erase batch.
type shortRun struct {
	repo        TenantPurgeRepository
	expected    tenantpurge.Plan
	target      string
	catalog     purgeCatalog
	fingerprint string
	selected    map[string]string
	retained    map[string]string
	backup      func(context.Context, tenantpurge.Plan) error
	deleting    bool
}

// shortSelect records where each result of the select batch sits.
type shortSelect struct {
	batch      shortSQL
	schema     int
	scope      int
	boundaries []int
	images     map[string]int
	protected  map[string]int
}

func (r TenantPurgeRepository) shortChange(ctx context.Context, expected tenantpurge.Plan, target string, catalog purgeCatalog, fingerprint string, selected, retained map[string]string, backup func(context.Context, tenantpurge.Plan) error, deleting bool) (tenantpurge.Plan, error) {
	run := shortRun{repo: r, expected: expected, target: target, catalog: catalog, fingerprint: fingerprint, selected: selected, retained: retained, backup: backup, deleting: deleting}
	return run.execute(ctx)
}

func (run shortRun) execute(ctx context.Context) (tenantpurge.Plan, error) {
	var objectSnapshot string
	if run.deleting {
		var err error
		objectSnapshot, err = run.repo.shortObjectSnapshot(ctx, run.catalog, run.retained, run.expected.Objects)
		if err != nil {
			return tenantpurge.Plan{}, err
		}
	}
	sel := run.buildSelect(objectSnapshot)
	ctx, cancel := context.WithTimeout(ctx, shortPurgeDeadline)
	defer cancel()
	tx, err := run.repo.pool.Begin(ctx)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer func() {
		rollback, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = tx.Rollback(rollback)
	}()
	if _, err := tx.Exec(ctx, shortFenceSQL(run.catalog, run.target), pgx.QueryExecModeSimpleProtocol); err != nil {
		return tenantpurge.Plan{}, err
	}
	results, err := sel.batch.run(ctx, tx)
	if err != nil {
		return tenantpurge.Plan{}, fmt.Errorf("short select: %w", err)
	}
	if err := run.checkSelect(results, sel); err != nil {
		return tenantpurge.Plan{}, err
	}
	current := run.currentPlan(results, sel)
	if err := run.settle(ctx, tx, &current); err != nil {
		return current, err
	}
	if err := run.backup(ctx, current); err != nil {
		return current, fmt.Errorf("encrypted before-image: %w", err)
	}
	if err := run.erase(ctx, tx, current, results, sel); err != nil {
		return current, err
	}
	if !run.deleting {
		tenants, _ := backfillIDs(run.expected.Scope, *run.expected.Backfill)
		if err := validateRaisedPolicies(ctx, tx, tenants); err != nil {
			return current, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return current, fmt.Errorf("commit outcome must be inspected: %w", err)
	}
	return current, nil
}

func (run shortRun) buildSelect(objectSnapshot string) shortSelect {
	sel := shortSelect{images: map[string]int{}, protected: map[string]int{}}
	b := &sel.batch
	sel.schema = b.add(shortSchemaSQL)
	sel.scope = b.add(`select coalesce(json_agg(json_build_object('id',id::text,'name',name)),'[]'::json)::text from public.tenants`)
	for _, table := range run.catalog.Tables {
		condition := run.selected[table.Name]
		if condition == "" {
			condition = "false"
		}
		b.add(`create temporary table ` + shortTemp(table.Name) + ` on commit drop as select * from ` + purgeName(table.Name) + ` where ` + condition + ` for update`)
	}
	if run.deleting {
		sel.boundaries = run.addBoundaryChecks(b, objectSnapshot)
	}
	for _, table := range run.catalog.Tables {
		if len(table.Primary) > 0 {
			sel.images[table.Name] = b.add(`select (` + primaryExpression(table, "r") + `)::text,to_jsonb(r)::text from ` + shortTemp(table.Name) + ` r order by (` + primaryExpression(table, "r") + `)::text`)
		}
		sel.protected[table.Name] = b.add(shortProtectedSQL(table))
	}
	return sel
}

// addBoundaryChecks adds the queries that must all return false: retained references, a wrapped
// transaction id, and live write authority in the selected rows.
func (run shortRun) addBoundaryChecks(b *shortSQL, objectSnapshot string) []int {
	var indexes []int
	for _, check := range shortBoundaryQueries(run.catalog) {
		indexes = append(indexes, b.add(check))
	}
	indexes = append(indexes, b.add(`select pg_snapshot_xmax(pg_current_snapshot())>='4294967296'::xid8`))
	indexes = append(indexes, b.add(shortObjectQueryAfterSnapshot(run.catalog, run.retained, run.expected.Objects, objectSnapshot)))
	for _, check := range []string{
		`select exists(select 1 from ` + shortTemp("episodes") + ` where status<>'ended')`,
		`select exists(select 1 from ` + shortTemp("recording_jobs") + ` where state not in ('succeeded','terminal_failure','cancelled'))`,
		`select exists(select 1 from ` + shortTemp("recording_reservations") + ` where state not in ('released','expired'))`,
	} {
		indexes = append(indexes, b.add(check))
	}
	return indexes
}

func (run shortRun) checkSelect(results []*pgconn.Result, sel shortSelect) error {
	if string(results[sel.schema].Rows[0][0]) != run.fingerprint {
		return errors.New("schema changed before fence")
	}
	ids := purgeIDs(run.expected.Scope)
	final := run.deleting && run.target == ids[len(ids)-1]
	if err := shortCheckScope(results[sel.scope].Rows[0], run.expected.Scope, run.target, final); err != nil {
		return err
	}
	for _, index := range sel.boundaries {
		if string(results[index].Rows[0][0]) != "f" {
			return errors.New("retained reference or active write authority blocks purge")
		}
	}
	return nil
}

// currentPlan turns the selected row images into the plan the backup and the erase batch work from.
func (run shortRun) currentPlan(results []*pgconn.Result, sel shortSelect) tenantpurge.Plan {
	current := run.expected
	current.CreatedAt = time.Now().UTC()
	current.Tables = nil
	for _, table := range run.catalog.Tables {
		data := shortTableImage(table, results, sel)
		if run.deleting || run.selected[table.Name] != "" {
			current.Tables = append(current.Tables, data)
		}
	}
	return current
}

func shortTableImage(table purgeTable, results []*pgconn.Result, sel shortSelect) tenantpurge.Table {
	data := tenantpurge.Table{Name: table.Name}
	var raw strings.Builder
	var ddl []string
	for _, column := range table.Columns {
		ddl = append(ddl, purgeQuote(column.Name)+" "+column.Type)
	}
	data.ColumnsDDL = strings.Join(ddl, ",")
	if index, ok := sel.images[table.Name]; ok {
		for _, row := range results[index].Rows {
			data.Rows = append(data.Rows, tenantpurge.Row{Key: json.RawMessage(row[0]), Value: json.RawMessage(row[1])})
			raw.Write(row[0])
			raw.WriteByte('\n')
			raw.Write(row[1])
			raw.WriteByte('\n')
		}
	}
	data.Count = int64(len(data.Rows))
	data.Digest = tenantpurge.Digest([]byte(raw.String()))
	return data
}

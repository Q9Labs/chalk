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

func (r TenantPurgeRepository) shortChange(ctx context.Context, expected tenantpurge.Plan, target string, catalog purgeCatalog, fingerprint string, selected, retained map[string]string, backup func(context.Context, tenantpurge.Plan) error, deleting bool) (tenantpurge.Plan, error) {
	var objectSnapshot string
	if deleting {
		var err error
		objectSnapshot, err = r.shortObjectSnapshot(ctx, catalog, retained, expected.Objects)
		if err != nil {
			return tenantpurge.Plan{}, err
		}
	}
	ids := purgeIDs(expected.Scope)
	final := deleting && target == ids[len(ids)-1]
	b := shortSQL{}
	// Fence is a separate batch because it contains multiple statements.
	schemaIndex := b.add(shortSchemaSQL)
	scopeIndex := b.add(`select coalesce(json_agg(json_build_object('id',id::text,'name',name)),'[]'::json)::text from public.tenants`)
	for _, table := range catalog.Tables {
		condition := selected[table.Name]
		if condition == "" {
			condition = "false"
		}
		b.add(`create temporary table ` + shortTemp(table.Name) + ` on commit drop as select * from ` + purgeName(table.Name) + ` where ` + condition + ` for update`)
	}
	var boundaryIndexes []int
	if deleting {
		for _, check := range shortBoundaryQueries(catalog) {
			boundaryIndexes = append(boundaryIndexes, b.add(check))
		}
		boundaryIndexes = append(boundaryIndexes, b.add(`select pg_snapshot_xmax(pg_current_snapshot())>='4294967296'::xid8`))
		boundaryIndexes = append(boundaryIndexes, b.add(shortObjectQueryAfterSnapshot(catalog, retained, expected.Objects, objectSnapshot)))
		for _, check := range []string{`select exists(select 1 from ` + shortTemp("episodes") + ` where status<>'ended')`, `select exists(select 1 from ` + shortTemp("recording_jobs") + ` where state not in ('succeeded','terminal_failure','cancelled'))`, `select exists(select 1 from ` + shortTemp("recording_reservations") + ` where state not in ('released','expired'))`} {
			boundaryIndexes = append(boundaryIndexes, b.add(check))
		}
	}
	images := map[string]int{}
	protected := map[string]int{}
	for _, table := range catalog.Tables {
		if len(table.Primary) > 0 {
			images[table.Name] = b.add(`select (` + primaryExpression(table, "r") + `)::text,to_jsonb(r)::text from ` + shortTemp(table.Name) + ` r order by (` + primaryExpression(table, "r") + `)::text`)
		}
		protected[table.Name] = b.add(shortProtectedSQL(table))
	}
	ctx, cancel := context.WithTimeout(ctx, shortPurgeDeadline)
	defer cancel()
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer func() {
		rollback, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = tx.Rollback(rollback)
	}()
	if _, err := tx.Exec(ctx, shortFenceSQL(catalog, target), pgx.QueryExecModeSimpleProtocol); err != nil {
		return tenantpurge.Plan{}, err
	}
	results, err := b.run(ctx, tx)
	if err != nil {
		return tenantpurge.Plan{}, fmt.Errorf("short select: %w", err)
	}
	if string(results[schemaIndex].Rows[0][0]) != fingerprint {
		return tenantpurge.Plan{}, errors.New("schema changed before fence")
	}
	if err := shortCheckScope(results[scopeIndex].Rows[0], expected.Scope, target, final); err != nil {
		return tenantpurge.Plan{}, err
	}
	for _, index := range boundaryIndexes {
		if string(results[index].Rows[0][0]) != "f" {
			return tenantpurge.Plan{}, errors.New("retained reference or active write authority blocks purge")
		}
	}
	current := expected
	current.CreatedAt = time.Now().UTC()
	current.Tables = nil
	for _, table := range catalog.Tables {
		data := tenantpurge.Table{Name: table.Name, Digest: tenantpurge.Digest(nil)}
		var raw strings.Builder
		var ddl []string
		for _, column := range table.Columns {
			ddl = append(ddl, purgeQuote(column.Name)+" "+column.Type)
		}
		data.ColumnsDDL = strings.Join(ddl, ",")
		if index, ok := images[table.Name]; ok {
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
		if deleting || selected[table.Name] != "" {
			current.Tables = append(current.Tables, data)
		}
	}
	if deleting {
		drainSelected := map[string]string{}
		for name, condition := range selected {
			drainSelected[name] = condition + " and cardinality($1::uuid[])>=0"
		}
		current.WriteDrain, err = snapshotPurgeWriteDrain(ctx, tx, catalog, drainSelected, []string{target})
		if err != nil {
			return current, err
		}
		if err := current.WriteDrain.Validate(time.Now().UTC()); err != nil {
			return current, err
		}
	} else {
		ordered := make([]tenantpurge.Table, 0, len(current.Tables))
		for _, wanted := range expected.Tables {
			for _, table := range current.Tables {
				if table.Name == wanted.Name {
					ordered = append(ordered, table)
				}
			}
		}
		current.Tables = ordered
		if err := tenantpurge.SameRows(expected, current); err != nil {
			return current, err
		}
	}
	if err := backup(ctx, current); err != nil {
		return current, fmt.Errorf("encrypted before-image: %w", err)
	}
	erase, err := shortEraseSQL(catalog, current, deleting)
	if err != nil {
		return current, err
	}
	post := map[string]int{}
	for _, table := range catalog.Tables {
		post[table.Name] = erase.add(shortProtectedSQL(table))
	}
	if deleting {
		for _, guard := range catalog.Triggers {
			if _, known := purgeAppendOnlyGuards[guard.Name]; known {
				erase.add(`alter table ` + purgeName(guard.Table) + ` enable trigger ` + purgeQuote(guard.Name))
			}
		}
	}
	restored := erase.add(shortSchemaSQL)
	after, err := erase.run(ctx, tx)
	if err != nil {
		return current, fmt.Errorf("short erase: %w", err)
	}
	for _, table := range catalog.Tables {
		before := results[protected[table.Name]].Rows[0]
		remaining := after[post[table.Name]].Rows[0]
		var selectedCount int64
		if deleting {
			for _, data := range current.Tables {
				if data.Name == table.Name {
					selectedCount = data.Count
				}
			}
		}
		var n, m int64
		if _, err := fmt.Sscan(string(before[0]), &n); err != nil {
			return current, err
		}
		if _, err := fmt.Sscan(string(remaining[0]), &m); err != nil {
			return current, err
		}
		if n-m != selectedCount || string(before[1]) != string(remaining[1]) {
			return current, fmt.Errorf("exact erase count or retained digest mismatch in %s", table.Name)
		}
	}
	if string(after[restored].Rows[0][0]) != fingerprint {
		return current, errors.New("schema guards not restored")
	}
	if !deleting {
		tenants, _ := backfillIDs(expected.Scope, *expected.Backfill)
		if err := validateRaisedPolicies(ctx, tx, tenants); err != nil {
			return current, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return current, fmt.Errorf("commit outcome must be inspected: %w", err)
	}
	return current, nil
}

func shortEraseSQL(catalog purgeCatalog, current tenantpurge.Plan, deleting bool) (shortSQL, error) {
	if !deleting {
		b := shortSQL{}
		tenants, spaces := backfillIDs(current.Scope, *current.Backfill)
		b.add(`update public.tenant_artifact_policies set transcription_ceiling=case when transcription_ceiling='disabled' or transcription_default_mode='disabled' then 'automatic' else transcription_ceiling end,transcription_default_mode=case when transcription_default_mode='disabled' then 'automatic' else transcription_default_mode end,provider_policy_version=case when btrim(provider_policy_version)='' then 'chalk-automatic-v1' else provider_policy_version end,source_window_seconds=case when source_window_seconds=0 then 86400 else source_window_seconds end,updated_at=now() where tenant_id=any(` + purgeArray(tenants) + `) and (transcription_ceiling='disabled' or transcription_default_mode='disabled')`)
		b.add(`update public.spaces set recording_policy='automatic',transcription_policy='automatic',updated_at=now() where id=any(` + purgeArray(spaces) + `) and recording_policy='disabled' and transcription_policy='disabled'`)
		return b, nil
	}
	erase := shortSQL{}
	for _, cut := range []struct{ table, set string }{
		{"recording_transcription_sources", "lease_transcript_id=null,lease_expires_at=null,status=case when status='leased' then 'cleanup_pending' else status end,cleanup_due_at=case when status='leased' then coalesce(cleanup_due_at,now()) else cleanup_due_at end"},
		{"sync_external_operations", "applied_event_id=null,applied_revision=null"},
		{"recording_capture_connections", "active_command_id=null,active_execution_token=null,active_execution_expires_at=null"},
	} {
		table, ok := catalog.table(cut.table)
		if !ok {
			return erase, errors.New("missing cycle-cut table")
		}
		erase.add(`update ` + purgeName(cut.table) + ` d set ` + cut.set + ` where exists(select 1 from ` + shortTemp(cut.table) + ` s where ` + purgePKJoin(table, "d", "s") + `)`)
	}
	parents := map[string][]string{}
	for _, fk := range catalog.FKs {
		if fk.Child == "webhook_endpoints" && fk.Parent == "webhook_endpoint_revisions" || fk.Child == "sync_external_operations" && fk.Parent == "sync_control_events" || fk.Child == "recording_capture_connections" && fk.Parent == "recording_capture_commands" || fk.Child == "recording_transcription_sources" && fk.Parent == "transcriptions" {
			continue
		}
		parents[fk.Child] = append(parents[fk.Child], fk.Parent)
	}
	var names []string
	for _, table := range current.Tables {
		if table.Count > 0 && table.Name != "webhook_endpoint_revisions" {
			names = append(names, table.Name)
		}
	}
	order, err := tenantpurge.DeleteOrder(names, parents)
	if err != nil {
		return erase, err
	}
	for _, trigger := range catalog.Triggers {
		function, known := purgeAppendOnlyGuards[trigger.Name]
		if !known {
			continue
		}
		if function != trigger.Function || trigger.Enabled != "O" {
			return erase, errors.New("unexpected append-only guard")
		}
		erase.add(`alter table ` + purgeName(trigger.Table) + ` disable trigger ` + purgeQuote(trigger.Name))
	}
	for _, name := range order {
		table, _ := catalog.table(name)
		erase.add(`delete from ` + purgeName(name) + ` d using ` + shortTemp(name) + ` s where ` + purgePKJoin(table, "d", "s"))
	}

	return erase, nil
}

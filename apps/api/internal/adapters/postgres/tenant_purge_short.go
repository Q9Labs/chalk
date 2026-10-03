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

// The wall-clock deadline includes the local encrypted fsync, not just SQL.
const shortPurgeDeadline = 2800 * time.Millisecond

type purgeQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// SnapshotShort deliberately uses autocommit reads: inventory does not fence
// writers or promise byte stability. Apply captures the authoritative rows.
func (r TenantPurgeRepository) SnapshotShort(ctx context.Context, scope tenantpurge.Scope, values bool) (tenantpurge.Plan, error) {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `set timezone='UTC'`); err != nil {
		return tenantpurge.Plan{}, err
	}
	var fingerprint string
	if err := conn.QueryRow(ctx, shortSchemaSQL).Scan(&fingerprint); err != nil {
		return tenantpurge.Plan{}, err
	}
	plan, _, _, err := snapshotPurge(ctx, conn, scope, values)
	if err != nil {
		return plan, err
	}
	catalog, err := loadPurgeCatalog(ctx, conn)
	if err != nil {
		return plan, err
	}
	digest, err := catalog.digest()
	if err != nil {
		return plan, err
	}
	if digest != plan.SchemaDigest {
		return plan, errors.New("schema changed during inventory")
	}
	var after string
	if err := conn.QueryRow(ctx, shortSchemaSQL).Scan(&after); err != nil {
		return plan, err
	}
	if after != fingerprint {
		return plan, errors.New("schema changed during short inventory")
	}
	plan.SchemaFingerprint = fingerprint
	return plan, checkPurgeScope(ctx, conn, scope, true)
}

func purgeLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
func purgeArray(ids []string) string {
	var values []string
	for _, id := range ids {
		values = append(values, purgeLiteral(id))
	}
	return "array[" + strings.Join(values, ",") + "]::uuid[]"
}

// Includes defaults, all constraints and trigger bodies, including UPDATE
// triggers, rather than assuming the DELETE-only planning catalog is enough.
const shortSchemaSQL = `select md5(coalesce(string_agg(v, E'\n' order by v),'')) from (
 select 'column:'||c.oid::text||':'||a.attnum||':'||a.attname||':'||a.atttypid||':'||a.atttypmod||':'||a.attnotnull||':'||a.attidentity::text||':'||a.attgenerated::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') v from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped
 union all select 'constraint:'||c.oid||':'||pg_get_constraintdef(c.oid) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'
 union all select 'trigger:'||t.oid||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid)||':'||pg_get_functiondef(t.tgfoid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
 ) s`

type shortSQL struct{ queries []string }

func (b *shortSQL) add(query string) int {
	b.queries = append(b.queries, query)
	return len(b.queries) - 1
}
func (b shortSQL) run(ctx context.Context, tx pgx.Tx) ([]*pgconn.Result, error) {
	results, err := tx.Conn().PgConn().Exec(ctx, strings.Join(b.queries, "; ")).ReadAll()
	if err != nil {
		return nil, err
	}
	if len(results) != len(b.queries) {
		return nil, errors.New("incomplete purge SQL batch")
	}
	return results, nil
}

func shortTemp(table string) string {
	return pgx.Identifier{"pg_temp", "chalk_purge_" + table}.Sanitize()
}
func shortProtectedSQL(table purgeTable) string {
	condition := "true"
	if len(table.Primary) > 0 {
		condition = "not exists(select 1 from " + shortTemp(table.Name) + " s where " + purgePKJoin(table, "r", "s") + ")"
	}
	return `select (select count(*) from ` + purgeName(table.Name) + `),encode(sha256(convert_to(coalesce(string_agg(to_jsonb(r)::text,E'\n' order by to_jsonb(r)::text),''),'UTF8')),'hex') from ` + purgeName(table.Name) + ` r where ` + condition
}

func (r TenantPurgeRepository) shortCatalog(ctx context.Context, plan tenantpurge.Plan) (purgeCatalog, string, error) {
	if err := plan.Scope.Validate(); err != nil {
		return purgeCatalog{}, "", err
	}
	var before string
	if err := r.pool.QueryRow(ctx, shortSchemaSQL).Scan(&before); err != nil {
		return purgeCatalog{}, "", err
	}
	if plan.SchemaFingerprint == "" || before != plan.SchemaFingerprint {
		return purgeCatalog{}, "", errors.New("fresh short schema fingerprint required after migrations")
	}
	catalog, err := loadPurgeCatalog(ctx, r.pool)
	if err != nil {
		return catalog, "", err
	}
	digest, err := catalog.digest()
	if err != nil {
		return catalog, "", err
	}
	if digest != plan.SchemaDigest {
		return catalog, "", errors.New("schema identity changed; refresh inventory after migrations")
	}
	var fingerprint string
	err = r.pool.QueryRow(ctx, shortSchemaSQL).Scan(&fingerprint)
	if err == nil && fingerprint != before {
		return catalog, "", errors.New("schema changed during startup check")
	}
	return catalog, fingerprint, err
}

func shortFenceSQL(catalog purgeCatalog, target string) string {
	var names []string
	for _, table := range catalog.Tables {
		names = append(names, purgeName(table.Name))
	}
	// A tenant advisory fence serializes this operator. Brief table writer
	// fences also cover callbacks, FK cascades and global user-linked rows;
	// they never update retained rows and release within the deadline.
	return `set local timezone='UTC';set local statement_timeout='2s';set local lock_timeout='200ms';set local transaction_timeout='3s';select pg_advisory_xact_lock(hashtextextended(` + purgeLiteral("chalk-tenant-purge:"+target) + `,0));lock table ` + strings.Join(names, ",") + ` in share row exclusive mode`
}

func shortCheckScope(rows [][]byte, scope tenantpurge.Scope, target string, final bool) error {
	var live []tenantpurge.Identity
	if err := json.Unmarshal(rows[0], &live); err != nil {
		return err
	}
	expected := map[string]string{}
	required := map[string]bool{}
	for _, t := range scope.Keep {
		expected[t.ID] = t.Name
		required[t.ID] = true
	}
	for _, t := range scope.Delete {
		expected[t.ID] = t.Name
	}
	if target != "" {
		required[target] = true
	}
	for _, t := range live {
		if expected[t.ID] != t.Name {
			return errors.New("tenant identity partition changed")
		}
		if final && t.ID != target && slices.Contains(purgeIDs(scope), t.ID) {
			return errors.New("global account erase must be the last approved Tenant")
		}
		delete(required, t.ID)
	}
	if len(required) > 0 {
		return errors.New("required Tenant disappeared")
	}
	return nil
}

// Shared accounts are erased with the final Tenant, after every approved
// Tenant's incoming FK has gone. Seed ONLY the inventoried account IDs; live
// kept memberships and other retained ownership still veto their selection.
func shortPredicates(catalog purgeCatalog, plan tenantpurge.Plan, target string) (map[string]string, map[string]string, error) {
	all, err := catalog.predicates()
	if err != nil {
		return nil, nil, err
	}
	var users []string
	for _, table := range plan.Tables {
		if table.Name == "users" {
			for _, row := range table.Rows {
				var key struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(row.Key, &key); err != nil {
					return nil, nil, err
				}
				users = append(users, key.ID)
			}
		}
	}
	oldUser := all["users"]
	needle := `exists(select 1 from public.memberships m where m.user_id=u.id and m.tenant_id=any($1::uuid[]))`
	exclusive := strings.TrimSuffix(strings.TrimPrefix(oldUser, "id in ("), ")")
	ids := purgeIDs(plan.Scope)
	final := target == ids[len(ids)-1]
	selected := map[string]string{}
	retained := map[string]string{}
	if plan.DeferredSeeds != nil {
		users = append(users, plan.DeferredSeeds.Users...)
	}
	// All observed approved memberships are candidates; live kept links veto.
	seededUser := strings.Replace(exclusive, needle, `(u.id=any(`+purgeArray(users)+`) or `+needle+`)`, 1)
	seededUser = strings.ReplaceAll(seededUser, "$1::uuid[]", purgeArray(ids))
	for name, condition := range all {
		retained[name] = strings.ReplaceAll(strings.ReplaceAll(condition, exclusive, seededUser), "$1::uuid[]", purgeArray(ids))
		user := "select u.id from public.users u where false"
		if final {
			user = seededUser
		}
		selected[name] = strings.ReplaceAll(strings.ReplaceAll(condition, exclusive, user), "$1::uuid[]", purgeArray([]string{target}))
	}
	if table, ok := catalog.table("observability_journey_events"); ok {
		var known []string
		var journeys, events []string
		for _, data := range plan.Tables {
			if data.Name == table.Name {
				for _, row := range data.Rows {
					known = append(known, purgeLiteral(string(row.Key))+"::jsonb")
					if row.JourneyID != "" {
						journeys = append(journeys, row.JourneyID)
					}
				}
			}
		}
		if plan.DeferredSeeds != nil {
			journeys = append(journeys, plan.DeferredSeeds.Journeys...)
			events = append(events, plan.DeferredSeeds.Events...)
		}
		var observed []string
		if len(known) > 0 {
			observed = append(observed, primaryExpression(table, table.Name)+" in("+strings.Join(known, ",")+")")
		}
		quoted := func(values []string) string {
			var q []string
			for _, v := range values {
				q = append(q, purgeLiteral(v))
			}
			return strings.Join(q, ",")
		}
		if len(journeys) > 0 {
			observed = append(observed, "journey_id::text in("+quoted(journeys)+")")
		}
		if len(events) > 0 {
			observed = append(observed, "event_id::text in("+quoted(events)+")")
		}
		liveSelected := selected[table.Name]
		liveRetained := retained[table.Name]
		selected[table.Name] = "false"
		if final {
			selected[table.Name] = strings.Join(append(observed, "("+liveSelected+")"), " or ")
		}
		retained[table.Name] = strings.Join(append(observed, "("+liveRetained+")"), " or ")
	}
	return selected, retained, nil
}

func shortBoundaryQueries(catalog purgeCatalog) []string {
	var checks []string
	for _, fk := range catalog.FKs {
		child, _ := catalog.table(fk.Child)
		outside := "true"
		if len(child.Primary) > 0 {
			outside = "not exists(select 1 from " + shortTemp(child.Name) + " s where " + purgePKJoin(child, "c", "s") + ")"
		}
		checks = append(checks, `select exists(select 1 from `+purgeName(fk.Child)+` c join `+shortTemp(fk.Parent)+` p on `+fk.join("c", "p")+` where `+outside+`)`)
	}
	if _, ok := catalog.table("feedback_reports"); ok {
		checks = append(checks, `select exists(select 1 from public.feedback_reports c where not exists(select 1 from `+shortTemp("feedback_reports")+` s where s.id=c.id) and (space_id in(select id from `+shortTemp("spaces")+`) or episode_id in(select id from `+shortTemp("episodes")+`)))`)
	}
	if _, ok := catalog.table("observability_journey_events"); ok {
		for _, table := range catalog.Tables {
			for _, column := range table.Columns {
				parent := ""
				if slices.Contains([]string{"journey_id", "root_journey_id", "submission_journey_id"}, column.Name) {
					parent = "journey_id"
				}
				if strings.HasSuffix(column.Name, "journey_event_id") || column.Name == "parent_event_id" {
					parent = "event_id"
				}
				if parent == "" {
					continue
				}
				outside := "true"
				if len(table.Primary) > 0 {
					outside = "not exists(select 1 from " + shortTemp(table.Name) + " s where " + purgePKJoin(table, "c", "s") + ")"
				}
				checks = append(checks, `select exists(select 1 from `+purgeName(table.Name)+` c where `+outside+` and c.`+purgeQuote(column.Name)+`::text in(select `+purgeQuote(parent)+`::text from `+shortTemp("observability_journey_events")+`))`)
			}
		}
	}
	return checks
}

func shortObjectQuery(catalog purgeCatalog, selected map[string]string, manifest *tenantpurge.ObjectManifest) string {
	if manifest == nil {
		return "select false"
	}
	var values []string
	decoded := false
	for _, o := range manifest.Objects {
		values = append(values, o.Key)
	}
	values = append(values, manifest.SharedPrefixes...)
	var patterns []string
	for _, value := range values {
		for _, char := range value {
			if char < 32 || char > 126 || strings.ContainsRune("\\\"&<>", char) {
				decoded = true
			}
		}
		pattern := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(value)
		patterns = append(patterns, purgeLiteral("%"+pattern+"%"))
	}
	for _, prefix := range manifest.SharedPrefixes {
		namespace := strings.TrimSuffix(prefix, "/")
		exact := namespace
		if !decoded {
			exact = "\"" + namespace + "\""
		}
		exact = strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(exact)
		if !decoded {
			exact = "%" + exact + "%"
		}
		patterns = append(patterns, purgeLiteral(exact))
	}
	if len(patterns) == 0 {
		return "select false"
	}
	var refs []string
	for _, table := range catalog.Tables {
		condition := selected[table.Name]
		if condition == "" {
			condition = "false"
		}
		match := `to_jsonb(r)::text like any(n.patterns)`
		// Decode unusual object keys exactly as the original erase scanner does;
		// ordinary product-generated keys need no per-scalar JSON traversal.
		if decoded {
			match = `exists(select 1 from (select v from jsonb_path_query(to_jsonb(r),'strict $.** ? (@.type() == "string")') v union all select k from jsonb_path_query(to_jsonb(r),'strict $.** ? (@.type() == "object").keyvalue().key') k) strings(v) where (v #>> '{}') like any(n.patterns))`
		}
		refs = append(refs, `exists(select 1 from (select * from `+purgeName(table.Name)+` where not coalesce((`+condition+`),false)) r cross join chalk_object_patterns n where `+match+`)`)
	}
	if len(refs) == 0 {
		return "select false"
	}
	return `with chalk_object_patterns as materialized(select array[` + strings.Join(patterns, ",") + `]::text[] patterns) select ` + strings.Join(refs, " or ")
}

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
		boundaryIndexes = append(boundaryIndexes, b.add(shortObjectQuery(catalog, retained, expected.Objects)))
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
		b.add(`update public.tenant_artifact_policies set transcription_ceiling=case when transcription_ceiling='disabled' then 'on_demand' else transcription_ceiling end,transcription_default_mode=case when transcription_default_mode='disabled' then 'on_demand' else transcription_default_mode end,provider_policy_version=case when btrim(provider_policy_version)='' then 'chalk-on-demand-v1' else provider_policy_version end,source_window_seconds=case when source_window_seconds=0 then 86400 else source_window_seconds end,updated_at=now() where tenant_id=any(` + purgeArray(tenants) + `) and (transcription_ceiling='disabled' or transcription_default_mode='disabled')`)
		b.add(`update public.spaces set recording_policy='automatic',transcription_policy='on_demand',updated_at=now() where id=any(` + purgeArray(spaces) + `) and recording_policy='disabled' and transcription_policy='disabled'`)
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

func (r TenantPurgeRepository) ApplyBackfillShort(ctx context.Context, expected tenantpurge.Plan, backup func(context.Context, tenantpurge.Plan) error) (tenantpurge.Plan, error) {
	if expected.Kind != "backfill" || expected.Backfill == nil || backup == nil {
		return tenantpurge.Plan{}, errors.New("backfill plan and backup sink required")
	}
	if err := expected.Backfill.Validate(expected.Scope); err != nil {
		return tenantpurge.Plan{}, err
	}
	catalog, fingerprint, err := r.shortCatalog(ctx, expected)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	tenants, spaces := backfillIDs(expected.Scope, *expected.Backfill)
	selected := map[string]string{"tenant_artifact_policies": `tenant_id=any(` + purgeArray(tenants) + `) and (transcription_ceiling='disabled' or transcription_default_mode='disabled')`, "spaces": `id=any(` + purgeArray(spaces) + `)`}
	return r.shortChange(ctx, expected, "", catalog, fingerprint, selected, nil, backup, false)
}

func (r TenantPurgeRepository) SnapshotBackfillShort(ctx context.Context, scope tenantpurge.Scope, b tenantpurge.Backfill, values bool) (tenantpurge.Plan, error) {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `set timezone='UTC'`); err != nil {
		return tenantpurge.Plan{}, err
	}
	var before string
	if err := conn.QueryRow(ctx, shortSchemaSQL).Scan(&before); err != nil {
		return tenantpurge.Plan{}, err
	}
	plan, _, err := snapshotBackfill(ctx, conn, scope, b, values)
	if err != nil {
		return plan, err
	}
	var after string
	if err := conn.QueryRow(ctx, shortSchemaSQL).Scan(&after); err != nil {
		return plan, err
	}
	if before != after {
		return plan, errors.New("schema changed during backfill inventory")
	}
	plan.SchemaFingerprint = before
	return plan, nil
}

// Each storage call has its own short reference fence. Do not keep one
// transaction open across hundreds of R2 HEAD/DELETE requests.
func (r TenantPurgeRepository) CleanupObjectsShort(ctx context.Context, plan tenantpurge.Plan, cleanup func(context.Context, tenantpurge.ObjectManifest) error) error {
	if plan.Objects == nil || cleanup == nil {
		return errors.New("object manifest and cleanup required")
	}
	if err := plan.Objects.Validate(plan.Scope); err != nil {
		return err
	}
	if err := plan.WriteDrain.Validate(time.Now().UTC()); err != nil {
		return err
	}
	catalog, fingerprint, err := r.shortCatalog(ctx, plan)
	if err != nil {
		return err
	}
	for _, object := range plan.Objects.Objects {
		err := func() error {
			ctx, cancel := context.WithTimeout(ctx, shortPurgeDeadline)
			defer cancel()
			tx, err := r.pool.Begin(ctx)
			if err != nil {
				return err
			}
			defer func() {
				rollback, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				_ = tx.Rollback(rollback)
			}()
			if _, err := tx.Exec(ctx, shortFenceSQL(catalog, "object-cleanup"), pgx.QueryExecModeSimpleProtocol); err != nil {
				return err
			}
			one := *plan.Objects
			one.Objects = []tenantpurge.StorageObject{object}
			b := shortSQL{}
			schema := b.add(shortSchemaSQL)
			scope := b.add(`select coalesce(json_agg(json_build_object('id',id::text,'name',name)),'[]'::json)::text from public.tenants`)
			absent := b.add(`select count(*) from public.tenants where id=any(` + purgeArray(purgeIDs(plan.Scope)) + `)`)
			refs := b.add(shortObjectQuery(catalog, nil, &one))
			result, err := b.run(ctx, tx)
			if err != nil {
				return err
			}
			if string(result[schema].Rows[0][0]) != fingerprint {
				return errors.New("cleanup schema changed")
			}
			if err := shortCheckScope(result[scope].Rows[0], plan.Scope, "", false); err != nil {
				return err
			}
			if string(result[absent].Rows[0][0]) != "0" || string(result[refs].Rows[0][0]) != "f" {
				return errors.New("deleted Tenant remains or kept object reference exists")
			}
			if err := cleanup(ctx, one); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

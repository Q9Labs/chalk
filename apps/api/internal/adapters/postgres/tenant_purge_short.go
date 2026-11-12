package postgres

import (
	"context"
	"encoding/json"
	"errors"
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
	// Under the writer fence an UPDATE creates a new xmin/ctid tuple version,
	// and DELETE/INSERT changes the multiset. Hash headers, not large retained
	// monitoring payloads. Vacuum/rewrite is also excluded by the table fence.
	// Numeric system fields contain no ':' or newline, so this encoding is
	// unambiguous without per-row JSON construction. tableoid disambiguates
	// physical tuple positions when reading partitioned parents.
	version := `r.tableoid::text||':'||r.xmin::text||':'||r.ctid::text`
	return `select (select count(*) from ` + purgeName(table.Name) + `),encode(sha256(convert_to(coalesce(string_agg(` + version + `,E'\n' order by ` + version + ` collate "C"),''),'UTF8')),'hex') from ` + purgeName(table.Name) + ` r where ` + condition
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
	// Catalog-wide scans cannot spend the short fence budget compiling JIT code.
	return `set local timezone='UTC';set local jit=off;set local statement_timeout='2s';set local lock_timeout='200ms';set local transaction_timeout='3s';select pg_advisory_xact_lock(hashtextextended(` + purgeLiteral("chalk-tenant-purge:"+target) + `,0));lock table ` + strings.Join(names, ",") + ` in share row exclusive mode`
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

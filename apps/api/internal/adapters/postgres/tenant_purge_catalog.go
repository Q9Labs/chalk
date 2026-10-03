package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

type purgeColumn struct{ Name, Type string }
type purgeTable struct {
	Name    string
	Columns []purgeColumn
	Primary []string
}
type purgeFK struct {
	Name, Child, Parent         string
	ChildColumns, ParentColumns []string
	Definition                  string
}
type purgeCatalog struct {
	Tables   []purgeTable
	FKs      []purgeFK
	Triggers []purgeTrigger
}

type purgeTrigger struct{ Table, Name, Function, Definition, FunctionDigest, Enabled string }

func loadPurgeCatalog(ctx context.Context, tx purgeQueryer) (purgeCatalog, error) {
	var catalog purgeCatalog
	rows, err := tx.Query(ctx, `select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`)
	if err != nil {
		return catalog, err
	}
	for rows.Next() {
		var name string
		var column purgeColumn
		if err := rows.Scan(&name, &column.Name, &column.Type); err != nil {
			rows.Close()
			return catalog, err
		}
		if len(catalog.Tables) == 0 || catalog.Tables[len(catalog.Tables)-1].Name != name {
			catalog.Tables = append(catalog.Tables, purgeTable{Name: name})
		}
		index := len(catalog.Tables) - 1
		catalog.Tables[index].Columns = append(catalog.Tables[index].Columns, column)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return catalog, err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `select c.relname,array_agg(a.attname::text order by k.ord) from pg_constraint p join pg_class c on c.oid=p.conrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral unnest(p.conkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=c.oid and a.attnum=k.num where n.nspname='public' and p.contype='p' group by c.relname order by c.relname`)
	if err != nil {
		return catalog, err
	}
	for rows.Next() {
		var name string
		var primary []string
		if err := rows.Scan(&name, &primary); err != nil {
			rows.Close()
			return catalog, err
		}
		for index := range catalog.Tables {
			if catalog.Tables[index].Name == name {
				catalog.Tables[index].Primary = primary
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return catalog, err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `select f.conname,child.relname,parent.relname,array(select a.attname::text from unnest(f.conkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.num order by k.ord),array(select a.attname::text from unnest(f.confkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=f.confrelid and a.attnum=k.num order by k.ord),pg_get_constraintdef(f.oid) from pg_constraint f join pg_class child on child.oid=f.conrelid join pg_class parent on parent.oid=f.confrelid join pg_namespace n on n.oid=child.relnamespace where n.nspname='public' and f.contype='f' order by child.relname,f.conname`)
	if err != nil {
		return catalog, err
	}
	for rows.Next() {
		var fk purgeFK
		if err := rows.Scan(&fk.Name, &fk.Child, &fk.Parent, &fk.ChildColumns, &fk.ParentColumns, &fk.Definition); err != nil {
			return catalog, err
		}
		catalog.FKs = append(catalog.FKs, fk)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return catalog, err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `select c.relname,t.tgname,p.proname,pg_get_triggerdef(t.oid),pg_get_functiondef(p.oid),t.tgenabled::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid where n.nspname='public' and not t.tgisinternal and (t.tgtype & 8)<>0 order by c.relname,t.tgname`)
	if err != nil {
		return catalog, err
	}
	defer rows.Close()
	for rows.Next() {
		var trigger purgeTrigger
		var function string
		if err := rows.Scan(&trigger.Table, &trigger.Name, &trigger.Function, &trigger.Definition, &function, &trigger.Enabled); err != nil {
			return catalog, err
		}
		trigger.FunctionDigest = tenantpurge.Digest([]byte(function))
		catalog.Triggers = append(catalog.Triggers, trigger)
	}
	return catalog, rows.Err()
}

func purgeName(name string) string  { return pgx.Identifier{"public", name}.Sanitize() }
func purgeQuote(name string) string { return pgx.Identifier{name}.Sanitize() }
func (t purgeTable) has(name string) bool {
	for _, c := range t.Columns {
		if c.Name == name {
			return true
		}
	}
	return false
}
func (c purgeCatalog) digest() (string, error) {
	data, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return tenantpurge.Digest(data), nil
}
func (c purgeCatalog) table(name string) (purgeTable, bool) {
	for _, t := range c.Tables {
		if t.Name == name {
			return t, true
		}
	}
	return purgeTable{}, false
}
func (f purgeFK) join(child, parent string) string {
	var comparisons []string
	for index, column := range f.ChildColumns {
		comparisons = append(comparisons, pgx.Identifier{child, column}.Sanitize()+"="+pgx.Identifier{parent, f.ParentColumns[index]}.Sanitize())
	}
	return strings.Join(comparisons, " and ")
}

// Tenant-keyed rows are never expanded into another Tenant. Only tables with
// no Tenant column follow FK descendants; retained incoming links abort erase.
func (c purgeCatalog) predicates() (map[string]string, error) {
	selected := make(map[string]string)
	for _, t := range c.Tables {
		if t.has("tenant_id") {
			selected[t.Name] = `tenant_id=any($1::uuid[])`
		}
	}
	selected["tenants"] = `id=any($1::uuid[])`
	exclusive := `select u.id from public.users u where exists(select 1 from public.memberships m where m.user_id=u.id and m.tenant_id=any($1::uuid[])) and not exists(select 1 from public.memberships m where m.user_id=u.id and not(m.tenant_id=any($1::uuid[])))`
	// An owner-only showcase registry follows its account, but no other global
	// user-owned resource is assumed to be disposable.
	for _, fk := range c.FKs {
		if fk.Parent != "users" || len(fk.ChildColumns) != 1 || slices.Contains([]string{"memberships", "auth_identities", "login_sessions", "password_resets"}, fk.Child) {
			continue
		}
		t, ok := c.table(fk.Child)
		if !ok {
			return nil, errors.New("missing FK child table")
		}
		condition := "true"
		if t.has("tenant_id") {
			condition = `tenant_id is null or not(tenant_id=any($1::uuid[]))`
		}
		if fk.Child == "showcase_dataset_registries" {
			condition = `product<>'chalk'`
		}
		exclusive += ` and not exists(select 1 from ` + purgeName(fk.Child) + ` where ` + purgeQuote(fk.ChildColumns[0]) + `=u.id and (` + condition + `))`
	}
	selected["users"] = `id in (` + exclusive + `)`
	if _, ok := c.table("showcase_dataset_registries"); ok {
		selected["showcase_dataset_registries"] = `product='chalk' and owner_user_id in (` + exclusive + `)`
	}
	for {
		changed := false
		for _, table := range c.Tables {
			if _, exists := selected[table.Name]; exists {
				continue
			}
			var paths []string
			for _, fk := range c.FKs {
				parent, ok := selected[fk.Parent]
				if fk.Child != table.Name || !ok || fk.Parent == table.Name {
					continue
				}
				paths = append(paths, `exists(select 1 from (select * from `+purgeName(fk.Parent)+` where `+parent+`) p where `+fk.join(table.Name, "p")+`)`)
			}
			if len(paths) > 0 {
				selected[table.Name] = strings.Join(paths, " or ")
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	var journeys, events []string
	for _, table := range c.Tables {
		condition, ok := selected[table.Name]
		if !ok || table.Name == "observability_journey_events" {
			continue
		}
		for _, column := range table.Columns {
			query := `select ` + purgeQuote(column.Name) + `::text from ` + purgeName(table.Name) + ` where (` + condition + `) and ` + purgeQuote(column.Name) + ` is not null`
			if slices.Contains([]string{"journey_id", "root_journey_id", "submission_journey_id"}, column.Name) {
				journeys = append(journeys, query)
			}
			if strings.HasSuffix(column.Name, "journey_event_id") {
				events = append(events, query)
			}
		}
	}
	if len(journeys) > 0 && len(events) > 0 {
		selected["observability_journey_events"] = `journey_id::text in (` + strings.Join(journeys, " union ") + `) or event_id::text in (` + strings.Join(events, " union ") + `)`
	}
	for _, table := range c.Tables {
		if condition, ok := selected[table.Name]; ok && condition != "false" && len(table.Primary) == 0 {
			return nil, fmt.Errorf("selected table %s has no primary key", table.Name)
		}
	}
	return selected, nil
}

func purgeIDs(scope tenantpurge.Scope) []string {
	result := make([]string, 0, len(scope.Delete))
	for _, t := range scope.Delete {
		result = append(result, t.ID)
	}
	sort.Strings(result)
	return result
}

func checkPurgeScope(ctx context.Context, tx purgeQueryer, scope tenantpurge.Scope, requireDeleted bool) error {
	if err := scope.Validate(); err != nil {
		return err
	}
	expected := make(map[string]string)
	required := make(map[string]bool)
	for _, t := range scope.Keep {
		expected[t.ID] = t.Name
		required[t.ID] = true
	}
	for _, t := range scope.Delete {
		expected[t.ID] = t.Name
		if requireDeleted {
			required[t.ID] = true
		}
	}
	rows, err := tx.Query(ctx, `select id::text,name from public.tenants order by id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		if want, ok := expected[id]; !ok || want != name {
			return errors.New("tenant identity partition changed")
		}
		delete(required, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(required) > 0 {
		return errors.New("required Tenant identity disappeared")
	}
	return nil
}

func primaryExpression(table purgeTable, alias string) string {
	var values []string
	for _, column := range table.Primary {
		values = append(values, "'"+strings.ReplaceAll(column, "'", "''")+"'", pgx.Identifier{alias, column}.Sanitize())
	}
	return `jsonb_build_object(` + strings.Join(values, ",") + `)`
}

func checkPurgeBoundaries(ctx context.Context, tx purgeQueryer, catalog purgeCatalog, selected map[string]string, ids []string) error {
	if err := checkPurgeLogicalBoundaries(ctx, tx, catalog, selected, ids); err != nil {
		return err
	}
	for _, fk := range catalog.FKs {
		parent, ok := selected[fk.Parent]
		if !ok {
			continue
		}
		if fk.Parent == "tenants" || (slices.Contains(fk.ChildColumns, "tenant_id") && slices.Contains(fk.ParentColumns, "tenant_id")) {
			continue
		}
		child := selected[fk.Child]
		if child == "" {
			child = "false"
		}
		query := `select exists(select 1 from (select * from ` + purgeName(fk.Child) + ` where not coalesce((` + child + `),false)) c join (select * from ` + purgeName(fk.Parent) + ` where ` + parent + `) p on ` + fk.join("c", "p") + `)`
		var exists bool
		if err := tx.QueryRow(ctx, query, ids).Scan(&exists); err != nil {
			return fmt.Errorf("check FK %s: %w", fk.Name, err)
		}
		if exists {
			return fmt.Errorf("retained row references approved erase through FK %s", fk.Name)
		}
	}
	return nil
}

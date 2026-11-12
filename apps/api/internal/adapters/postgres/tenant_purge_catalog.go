package postgres

import (
	"context"
	"encoding/json"
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

func purgeIDs(scope tenantpurge.Scope) []string {
	result := make([]string, 0, len(scope.Delete))
	for _, t := range scope.Delete {
		result = append(result, t.ID)
	}
	sort.Strings(result)
	return result
}

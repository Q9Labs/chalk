package postgres

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func shortObjectQuery(catalog purgeCatalog, selected map[string]string, manifest *tenantpurge.ObjectManifest) string {
	return shortObjectQueryAfterSnapshot(catalog, selected, manifest, "")
}

func shortObjectQueryAfterSnapshot(catalog purgeCatalog, selected map[string]string, manifest *tenantpurge.ObjectManifest, snapshot string) string {
	if manifest == nil {
		return "select false"
	}
	var values []string
	var namespaces []string
	seen := map[string]bool{}
	addNamespace := func(prefix string) {
		if !seen[prefix] {
			seen[prefix] = true
			values = append(values, prefix)
			namespaces = append(namespaces, prefix)
		}
	}
	for _, prefix := range manifest.SharedPrefixes {
		addNamespace(prefix)
	}
	decoded := false
	for _, o := range manifest.Objects {
		// Validated ownership lets us fence the whole approved namespace once.
		// This is stronger than matching every object individually, and avoids
		// rescanning large retained JSON values hundreds of times per row.
		prefix := "tenants/" + o.OwnerTenantID + "/"
		if o.OwnerTenantID != "" && strings.HasPrefix(o.Key, prefix) {
			addNamespace(prefix)
			continue
		}
		covered := false
		for _, prefix := range manifest.SharedPrefixes {
			if strings.HasPrefix(o.Key, prefix) {
				covered = true
			}
		}
		if covered {
			continue
		}
		values = append(values, o.Key)
	}
	var patterns []string
	for _, value := range values {
		for _, char := range value {
			if char < 32 || char > 126 || strings.ContainsRune("\\\"&<>", char) {
				decoded = true
			}
		}
		patterns = append(patterns, regexp.QuoteMeta(value))
	}
	for _, prefix := range namespaces {
		namespace := strings.TrimSuffix(prefix, "/")
		exact := namespace
		if !decoded {
			exact = "\"" + namespace + "\""
		}
		exact = regexp.QuoteMeta(exact)
		if decoded {
			exact = "^" + exact + "$"
		}
		patterns = append(patterns, exact)
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
		version := ""
		// Direct Tenant ownership changes necessarily UPDATE this tuple. An
		// unconditionally retained table cannot change ownership. Other logical
		// and user-linked predicates can change without updating their child:
		// scan those fully, including accounts newly linked to kept Tenants.
		if snapshot != "" && (table.has("tenant_id") || condition == "false") {
			// Use the oldest-active cutoff, not pg_visible_in_snapshot: xmin may
			// be a subtransaction ID absent from the snapshot's top-level xip list.
			version = ` and ` + pgx.Identifier{table.Name, "xmin"}.Sanitize() + `::text::xid8>=pg_snapshot_xmin(` + purgeLiteral(snapshot) + `::pg_snapshot)`
		}
		match := `to_jsonb(r)::text ~ n.pattern`
		// Decode unusual object keys exactly as the original erase scanner does;
		// ordinary product-generated keys need no per-scalar JSON traversal.
		if decoded {
			match = `exists(select 1 from (select v from jsonb_path_query(to_jsonb(r),'strict $.** ? (@.type() == "string")') v union all select k from jsonb_path_query(to_jsonb(r),'strict $.** ? (@.type() == "object").keyvalue().key') k) strings(v) where (v #>> '{}') ~ n.pattern)`
		}
		refs = append(refs, `exists(select 1 from (select * from `+purgeName(table.Name)+` where not coalesce((`+condition+`),false)`+version+`) r cross join chalk_object_patterns n where `+match+`)`)
	}
	if len(refs) == 0 {
		return "select false"
	}
	return `with chalk_object_patterns as materialized(select ` + purgeLiteral("("+strings.Join(patterns, "|")+")") + `::text pattern) select ` + strings.Join(refs, " or ")
}

func (r TenantPurgeRepository) shortObjectSnapshot(ctx context.Context, catalog purgeCatalog, selected map[string]string, manifest *tenantpurge.ObjectManifest) (string, error) {
	if manifest == nil {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	var snapshot string
	var epochOK, referenced bool
	query := `with s as materialized(select pg_current_snapshot() snapshot) select snapshot::text,pg_snapshot_xmax(snapshot)<'4294967296'::xid8,(` + shortObjectQuery(catalog, selected, manifest) + `) from s`
	if err := r.pool.QueryRow(ctx, query).Scan(&snapshot, &epochOK, &referenced); err != nil {
		return "", fmt.Errorf("object reference preflight: %w", err)
	}
	if !epochOK {
		return "", errors.New("object version fence requires epoch-zero transaction IDs")
	}
	if referenced {
		return "", errors.New("retained reference in object namespace before fence")
	}
	return snapshot, nil
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
	objectSnapshot, err := r.shortObjectSnapshot(ctx, catalog, nil, plan.Objects)
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
			epoch := b.add(`select pg_snapshot_xmax(pg_current_snapshot())>='4294967296'::xid8`)
			refs := b.add(shortObjectQueryAfterSnapshot(catalog, nil, &one, objectSnapshot))
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
			if string(result[absent].Rows[0][0]) != "0" || string(result[refs].Rows[0][0]) != "f" || string(result[epoch].Rows[0][0]) != "f" {
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

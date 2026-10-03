package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

var purgeJSONString = regexp.MustCompile(`"(?:[^"\\]|\\.)*"`)

func (r TenantPurgeRepository) VerifyPurgeObjects(ctx context.Context, plan tenantpurge.Plan) error {
	if plan.Objects == nil {
		return errors.New("object manifest required")
	}
	if err := plan.Objects.Validate(plan.Scope); err != nil {
		return err
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := checkPurgeScope(ctx, tx, plan.Scope, true); err != nil {
		return err
	}
	catalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return err
	}
	selected, err := catalog.predicates()
	if err != nil {
		return err
	}
	if err := checkRetainedObjectReferences(ctx, tx, catalog, selected, purgeIDs(plan.Scope), *plan.Objects); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r TenantPurgeRepository) VerifyObjectCleanup(ctx context.Context, plan tenantpurge.Plan) error {
	if plan.Objects == nil {
		return errors.New("object manifest required")
	}
	if err := plan.Objects.Validate(plan.Scope); err != nil {
		return err
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := verifyObjectCleanupTx(ctx, tx, plan); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CleanupObjects fences retained SQL writers for the whole external cleanup.
// A read-only preflight alone would permit a new retained reference to race it.
func (r TenantPurgeRepository) CleanupObjects(ctx context.Context, plan tenantpurge.Plan, cleanup func() error) error {
	if plan.Objects == nil {
		return errors.New("object manifest required")
	}
	if err := plan.Objects.Validate(plan.Scope); err != nil {
		return err
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	catalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return err
	}
	if err := lockPurgeTables(ctx, tx, catalog); err != nil {
		return err
	}
	if err := verifyObjectCleanupTx(ctx, tx, plan); err != nil {
		return err
	}
	if err := cleanup(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func verifyObjectCleanupTx(ctx context.Context, tx pgx.Tx, plan tenantpurge.Plan) error {
	if err := plan.WriteDrain.Validate(time.Now().UTC()); err != nil {
		return err
	}
	if err := checkPurgeScope(ctx, tx, plan.Scope, false); err != nil {
		return err
	}
	var count int64
	if err := tx.QueryRow(ctx, `select count(*) from public.tenants where id=any($1::uuid[])`, purgeIDs(plan.Scope)).Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return errors.New("relational erase must commit before object cleanup")
	}
	catalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return err
	}
	return checkRetainedObjectReferences(ctx, tx, catalog, nil, nil, *plan.Objects)
}

func checkRetainedObjectReferences(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, selected map[string]string, ids []string, manifest tenantpurge.ObjectManifest) error {
	keys := make(map[string]bool)
	for _, object := range manifest.Objects {
		keys[object.Key] = true
	}
	// Inspect every retained JSON/string column, not merely direct artifact
	// columns. A remaining dataset/namespace reference holds shared objects.
	for _, table := range catalog.Tables {
		condition := selected[table.Name]
		if condition == "" {
			condition = "false"
		}
		query := `select to_jsonb(r)::text from (select * from ` + purgeName(table.Name) + ` where not coalesce((` + condition + `),false) and coalesce(cardinality($1::uuid[]),0)>=0) r`
		rows, err := tx.Query(ctx, query, ids)
		if err != nil {
			return err
		}
		for rows.Next() {
			var row string
			if err := rows.Scan(&row); err != nil {
				rows.Close()
				return err
			}
			for _, token := range purgeJSONString.FindAllString(row, -1) {
				var value string
				if err := json.Unmarshal([]byte(token), &value); err != nil {
					rows.Close()
					return err
				}
				objectReference := keys[value]
				for key := range keys {
					if strings.Contains(value, key) {
						objectReference = true
						break
					}
				}
				if objectReference {
					rows.Close()
					return errors.New("kept row references an approved storage object")
				}
				for _, prefix := range manifest.SharedPrefixes {
					namespace := strings.TrimSuffix(prefix, "/")
					if strings.Contains(value, prefix) || value == namespace {
						rows.Close()
						return errors.New("kept row still references a shared storage namespace")
					}
				}
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}
	return nil
}

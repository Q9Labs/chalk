package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func readPurgeTable(ctx context.Context, tx purgeQueryer, table purgeTable, condition string, ids []string, values bool) (tenantpurge.Table, error) {
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
		if table.Name == "observability_journey_events" {
			var event struct {
				JourneyID string `json:"journey_id"`
			}
			if err := json.Unmarshal([]byte(value), &event); err != nil {
				return result, err
			}
			row.JourneyID = event.JourneyID
		}
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

func snapshotPurge(ctx context.Context, tx purgeQueryer, scope tenantpurge.Scope, values bool) (tenantpurge.Plan, purgeCatalog, map[string]string, error) {
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

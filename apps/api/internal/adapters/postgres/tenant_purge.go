package postgres

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TenantPurgeRepository struct{ pool *pgxpool.Pool }

func NewTenantPurgeRepository(pool *pgxpool.Pool) TenantPurgeRepository {
	return TenantPurgeRepository{pool: pool}
}

type purgeRef struct{ Tenant, ID string }

type purgeRevisionRef struct {
	Tenant, ID string
	Revision   int
}

func (r purgeRef) parse() (tenantID, id utilities.ID, err error) {
	return parsePurgeRef(r.Tenant, r.ID)
}

func parsePurgeRef(tenant, entity string) (tenantID, id utilities.ID, err error) {
	if tenantID, err = utilities.ParseID(tenant); err != nil {
		return tenantID, id, err
	}
	id, err = utilities.ParseID(entity)
	return tenantID, id, err
}

// reusePurgeEraseHelpers runs the product's own erase paths for the rows that carry payloads
// outside plain table deletes: transcripts and webhook endpoints.
func reusePurgeEraseHelpers(ctx context.Context, tx pgx.Tx, ids []string) error {
	rows, err := tx.Query(ctx, `select tenant_id::text,id::text from public.transcriptions where tenant_id=any($1::uuid[]) and deleted_at is null order by id`, ids)
	if err != nil {
		return err
	}
	transcripts, err := pgx.CollectRows(rows, pgx.RowToStructByPos[purgeRef])
	if err != nil {
		return err
	}
	for _, ref := range transcripts {
		tenantID, id, err := ref.parse()
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
	endpoints, err := pgx.CollectRows(rows, pgx.RowToStructByPos[purgeRevisionRef])
	if err != nil {
		return err
	}
	for _, ref := range endpoints {
		tenantID, id, err := parsePurgeRef(ref.Tenant, ref.ID)
		if err != nil {
			return err
		}
		if _, err := eraseWebhookEndpointTx(ctx, tx, tenantID, id, ref.Revision); err != nil {
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

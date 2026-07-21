package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAPIKeyRepositoryRequiresTransactorForMutation(t *testing.T) {
	repository := postgres.NewAPIKeyRepository(&apiKeyQueries{}, nil)
	_, err := repository.Create(context.Background(), apikeys.CreateRecordInput{})
	if err == nil || !strings.Contains(err.Error(), "transaction unavailable") {
		t.Fatalf("error = %v, want transaction unavailable", err)
	}
}

func TestAPIKeyRepositoryGetUsesTenantFilterAndMapsMissing(t *testing.T) {
	tenantID := apiKeyID(t, "22222222-2222-4222-8222-222222222222")
	id := apiKeyID(t, "11111111-1111-4111-8111-111111111111")
	queries := &apiKeyQueries{getErr: pgx.ErrNoRows}
	repository := postgres.NewAPIKeyRepository(queries, nil)

	_, err := repository.Get(context.Background(), tenantID, id)
	if !errors.Is(err, apikeys.ErrAPIKeyNotFound) {
		t.Fatalf("error = %v, want %v", err, apikeys.ErrAPIKeyNotFound)
	}
	if queries.getArg.TenantID.Bytes != tenantID.Bytes() || queries.getArg.ID.Bytes != id.Bytes() {
		t.Fatalf("query IDs = %#v", queries.getArg)
	}
}

func TestAPIKeyRepositoryGetByPrefixMapsInactiveAsMissing(t *testing.T) {
	queries := &apiKeyQueries{getByPrefixErr: pgx.ErrNoRows}
	repository := postgres.NewAPIKeyRepository(queries, nil)

	_, err := repository.GetByPrefix(context.Background(), "prefix123")
	if !errors.Is(err, apikeys.ErrAPIKeyNotFound) {
		t.Fatalf("error = %v, want %v", err, apikeys.ErrAPIKeyNotFound)
	}
	if queries.getByPrefix != "prefix123" {
		t.Fatalf("prefix = %q", queries.getByPrefix)
	}
}

func TestAPIKeyRepositoryListUsesTenantCursorAndExtraRow(t *testing.T) {
	tenantID := apiKeyID(t, "22222222-2222-4222-8222-222222222222")
	firstID := apiKeyID(t, "11111111-1111-4111-8111-111111111111")
	secondID := apiKeyID(t, "33333333-3333-4333-8333-333333333333")
	cursorID := apiKeyID(t, "44444444-4444-4444-8444-444444444444")
	cursorTime := apiKeyTime(-time.Hour)
	page, err := pagination.NewPageRequest(1, &pagination.Cursor{CreatedAt: cursorTime, ID: cursorID})
	if err != nil {
		t.Fatalf("page: %v", err)
	}
	queries := &apiKeyQueries{listRows: []sqlc.ListTenantAPIKeysRow{
		sqlc.ListTenantAPIKeysRow(apiKeyRow(firstID, tenantID, "first")),
		sqlc.ListTenantAPIKeysRow(apiKeyRow(secondID, tenantID, "second")),
	}}
	repository := postgres.NewAPIKeyRepository(queries, nil)

	list, err := repository.List(context.Background(), tenantID, page)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if queries.listArg.TenantID.Bytes != tenantID.Bytes() || queries.listArg.PageSize != 2 {
		t.Fatalf("list params = %#v", queries.listArg)
	}
	if !queries.listArg.CursorSet || queries.listArg.CursorID.Bytes != cursorID.Bytes() || !queries.listArg.CursorCreatedAt.Time.Equal(cursorTime) {
		t.Fatalf("cursor params = %#v", queries.listArg)
	}
	if len(list.Records) != 1 || list.Records[0].ID != firstID || !list.Page.HasMore {
		t.Fatalf("list = %#v", list)
	}
	if list.Page.NextCursor == nil || list.Page.NextCursor.ID != firstID {
		t.Fatalf("next cursor = %#v", list.Page.NextCursor)
	}
}

func TestAPIKeyRepositoryUsageTouchMapsInputs(t *testing.T) {
	id := apiKeyID(t, "11111111-1111-4111-8111-111111111111")
	now := apiKeyTime(0)
	address := netip.MustParseAddr("203.0.113.8")
	queries := &apiKeyQueries{}
	repository := postgres.NewAPIKeyRepository(queries, nil)

	if err := repository.TouchLastUsed(context.Background(), apikeys.Usage{KeyID: id, UsedAt: now, IPAddress: address}); err != nil {
		t.Fatalf("touch: %v", err)
	}
	if queries.touchArg.ID.Bytes != id.Bytes() || queries.touchArg.IpAddress == nil || *queries.touchArg.IpAddress != address {
		t.Fatalf("touch params = %#v", queries.touchArg)
	}
}

func TestAPIKeyRepositoryMutationsCommitWithBoundedAudit(t *testing.T) {
	pool := apiKeyTestPool(t)
	ctx := context.Background()
	tenantID := apiKeyNewID(t)
	keyID := apiKeyNewID(t)
	actorKeyID := apiKeyNewID(t)
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, tenantID, "API key repository test"); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from audit_logs where tenant_id = $1`, tenantID)
		pool.Exec(ctx, `delete from api_keys where tenant_id = $1`, tenantID)
		pool.Exec(ctx, `delete from tenants where id = $1`, tenantID)
	})

	repository := postgres.NewAPIKeyRepository(sqlc.New(pool), pool)
	ctx = authentication.ContextWithPrincipal(ctx, authentication.Principal{
		Kind: authentication.PrincipalAPIKey, TenantID: tenantID, APIKeyID: actorKeyID,
	})
	now := time.Now().UTC()
	created, err := repository.Create(ctx, apikeys.CreateRecordInput{
		ID: keyID, TenantID: tenantID, Name: "Production",
		Scopes:    []authentication.Scope{authentication.ScopeRoomsWrite},
		KeyPrefix: "create_" + keyID.String()[:8], KeyHash: "create-hash",
		ExpiresAt: now.Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID != keyID || created.TenantID != tenantID || created.KeyHash != "create-hash" {
		t.Fatalf("created = %#v", created)
	}
	_, err = repository.Create(ctx, apikeys.CreateRecordInput{
		ID: apiKeyNewID(t), TenantID: tenantID, Name: "Duplicate prefix",
		Scopes:    []authentication.Scope{authentication.ScopeRoomsRead},
		KeyPrefix: created.Prefix, KeyHash: "different-hash", ExpiresAt: now.Add(24 * time.Hour),
	})
	if !errors.Is(err, apikeys.ErrPrefixConflict) {
		t.Fatalf("duplicate prefix error = %v, want %v", err, apikeys.ErrPrefixConflict)
	}

	rotated, err := repository.Rotate(ctx, apikeys.RotateRecordInput{
		TenantID: tenantID, ID: keyID, KeyPrefix: "rotate_" + keyID.String()[:8],
		KeyHash: "rotate-hash", ExpiresAt: now.Add(48 * time.Hour), RotatedAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.KeyHash != "rotate-hash" || rotated.Prefix != "rotate_"+keyID.String()[:8] {
		t.Fatalf("rotated = %#v", rotated)
	}
	if err := repository.Revoke(ctx, tenantID, keyID, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := repository.GetByPrefix(ctx, rotated.Prefix); !errors.Is(err, apikeys.ErrAPIKeyNotFound) {
		t.Fatalf("revoked prefix lookup = %v, want %v", err, apikeys.ErrAPIKeyNotFound)
	}

	rows, err := pool.Query(ctx, `
select actor_type, action, resource_type, resource_id, outcome, details
from audit_logs
where tenant_id = $1
order by created_at, action`, tenantID)
	if err != nil {
		t.Fatalf("query audit logs: %v", err)
	}
	defer rows.Close()
	wantActions := map[string]bool{
		"api_key.created": false, "api_key.rotated": false, "api_key.revoked": false,
	}
	count := 0
	for rows.Next() {
		var actorType, action, resourceType, outcome string
		var details []byte
		var resourceID pgtype.UUID
		if err := rows.Scan(&actorType, &action, &resourceType, &resourceID, &outcome, &details); err != nil {
			t.Fatalf("scan audit log: %v", err)
		}
		if actorType != "api_key" || resourceType != "api_key" || resourceID.Bytes != keyID.Bytes() || outcome != "success" {
			t.Fatalf("audit = %q %q %v %q", actorType, resourceType, resourceID, outcome)
		}
		var decodedDetails map[string]string
		if err := json.Unmarshal(details, &decodedDetails); err != nil {
			t.Fatalf("decode audit details: %v", err)
		}
		if len(decodedDetails) != 1 || decodedDetails["actor_api_key_id"] != actorKeyID.String() {
			t.Fatalf("audit details = %s", details)
		}
		wantActions[action] = true
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate audit logs: %v", err)
	}
	if count != 3 {
		t.Fatalf("audit count = %d, want 3", count)
	}
	for action, found := range wantActions {
		if !found {
			t.Fatalf("missing audit action %s", action)
		}
	}
}

func TestAPIKeyRepositoryRollsBackMutationWhenAuditFails(t *testing.T) {
	pool := apiKeyTestPool(t)
	ctx := context.Background()
	tenantID := apiKeyNewID(t)
	keyID := apiKeyNewID(t)
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, tenantID, "API key rollback test"); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from audit_logs where tenant_id = $1`, tenantID)
		pool.Exec(ctx, `delete from api_keys where tenant_id = $1`, tenantID)
		pool.Exec(ctx, `delete from tenants where id = $1`, tenantID)
	})

	repository := postgres.NewAPIKeyRepository(sqlc.New(pool), failingAPIKeyAuditTransactor{pool: pool})
	_, err := repository.Create(ctx, apikeys.CreateRecordInput{
		ID: keyID, TenantID: tenantID, Name: "Rollback",
		Scopes:    []authentication.Scope{authentication.ScopeRoomsRead},
		KeyPrefix: "rollback_" + keyID.String()[:8], KeyHash: "rollback-hash",
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
	})
	if err == nil || !strings.Contains(err.Error(), "forced audit failure") {
		t.Fatalf("error = %v, want forced audit failure", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from api_keys where id = $1`, keyID).Scan(&count); err != nil {
		t.Fatalf("count API keys: %v", err)
	}
	if count != 0 {
		t.Fatalf("API key count = %d, want rollback", count)
	}
}

type failingAPIKeyAuditTransactor struct {
	pool *pgxpool.Pool
}

func (t failingAPIKeyAuditTransactor) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := t.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return failingAPIKeyAuditTx{Tx: tx}, nil
}

type failingAPIKeyAuditTx struct {
	pgx.Tx
}

func (tx failingAPIKeyAuditTx) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if strings.Contains(query, "-- name: CreateAuditLog") {
		return failingAPIKeyAuditRow{}
	}
	return tx.Tx.QueryRow(ctx, query, args...)
}

type failingAPIKeyAuditRow struct{}

func (failingAPIKeyAuditRow) Scan(...any) error {
	return errors.New("forced audit failure")
}

type apiKeyQueries struct {
	getArg         sqlc.GetTenantAPIKeyParams
	getErr         error
	getByPrefix    string
	getByPrefixErr error
	listArg        sqlc.ListTenantAPIKeysParams
	listRows       []sqlc.ListTenantAPIKeysRow
	listErr        error
	touchArg       sqlc.TouchActiveAPIKeyLastUsedParams
	touchErr       error
}

func (q *apiKeyQueries) GetActiveAPIKeyByPrefix(_ context.Context, prefix string) (sqlc.GetActiveAPIKeyByPrefixRow, error) {
	q.getByPrefix = prefix
	return sqlc.GetActiveAPIKeyByPrefixRow{}, q.getByPrefixErr
}

func (q *apiKeyQueries) GetTenantAPIKey(_ context.Context, arg sqlc.GetTenantAPIKeyParams) (sqlc.GetTenantAPIKeyRow, error) {
	q.getArg = arg
	return sqlc.GetTenantAPIKeyRow{}, q.getErr
}

func (q *apiKeyQueries) ListTenantAPIKeys(_ context.Context, arg sqlc.ListTenantAPIKeysParams) ([]sqlc.ListTenantAPIKeysRow, error) {
	q.listArg = arg
	return q.listRows, q.listErr
}

func (q *apiKeyQueries) TouchActiveAPIKeyLastUsed(_ context.Context, arg sqlc.TouchActiveAPIKeyLastUsedParams) error {
	q.touchArg = arg
	return q.touchErr
}

func apiKeyRow(id, tenantID utilities.ID, name string) sqlc.GetTenantAPIKeyRow {
	now := apiKeyTime(0)
	return sqlc.GetTenantAPIKeyRow{
		ID:        pgtype.UUID{Bytes: id.Bytes(), Valid: true},
		TenantID:  pgtype.UUID{Bytes: tenantID.Bytes(), Valid: true},
		Name:      name,
		Scopes:    []string{string(authentication.ScopeRoomsWrite), string(authentication.ScopeSessionsWrite)},
		KeyHash:   "stored-hash",
		KeyPrefix: "prefix123",
		ExpiresAt: pgtype.Timestamptz{Time: now.Add(24 * time.Hour), Valid: true},
		UpdatedAt: pgtype.Timestamptz{Time: now, Valid: true},
		CreatedAt: pgtype.Timestamptz{Time: now, Valid: true},
	}
}

func apiKeyID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse ID: %v", err)
	}
	return id
}

func apiKeyTime(offset time.Duration) time.Time {
	return time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC).Add(offset)
}

func apiKeyNewID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("new ID: %v", err)
	}
	return id
}

func apiKeyTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable")
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

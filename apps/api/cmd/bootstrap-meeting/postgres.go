package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type bootstrapDatabase interface {
	BeginBootstrap(context.Context) (bootstrapTransaction, error)
	Close()
}

type postgresBootstrapDatabase struct {
	pool *pgxpool.Pool
}

type postgresBootstrapTransaction struct {
	tx      pgx.Tx
	queries *sqlc.Queries
}

func openBootstrapDatabase(ctx context.Context, databaseURL string) (bootstrapDatabase, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, errors.New("database connection configuration is invalid")
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, errors.New("database connection failed")
	}
	return &postgresBootstrapDatabase{pool: pool}, nil
}

func (d *postgresBootstrapDatabase) BeginBootstrap(ctx context.Context) (bootstrapTransaction, error) {
	tx, err := d.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, errors.New("begin database transaction failed")
	}
	return newPostgresBootstrapTransaction(tx), nil
}

func (d *postgresBootstrapDatabase) Close() {
	d.pool.Close()
}

func newPostgresBootstrapTransaction(tx pgx.Tx) *postgresBootstrapTransaction {
	return &postgresBootstrapTransaction{tx: tx, queries: sqlc.New(tx)}
}

func (t *postgresBootstrapTransaction) Lock(ctx context.Context, name string) error {
	_, err := t.tx.Exec(ctx, "select pg_advisory_xact_lock(hashtextextended($1, 0))", name)
	return err
}

func (t *postgresBootstrapTransaction) UserExists(ctx context.Context, userID utilities.ID) (bool, error) {
	var exists bool
	err := t.tx.QueryRow(ctx, "select exists(select 1 from users where id = $1::uuid)", userID.String()).Scan(&exists)
	return exists, err
}

func (t *postgresBootstrapTransaction) TenantByName(ctx context.Context, name string) (tenants.Tenant, bool, error) {
	rows, err := t.tx.Query(ctx, `
select id::text, name, default_media_plane, media_plane_provider_config
from tenants
where name = $1
order by created_at, id
limit 2`, name)
	if err != nil {
		return tenants.Tenant{}, false, err
	}
	defer rows.Close()

	var found []tenants.Tenant
	for rows.Next() {
		var (
			tenantID        string
			defaultProvider *string
			providerConfig  []byte
			rowName         string
		)
		if err := rows.Scan(&tenantID, &rowName, &defaultProvider, &providerConfig); err != nil {
			return tenants.Tenant{}, false, err
		}
		id, err := utilities.ParseID(tenantID)
		if err != nil {
			return tenants.Tenant{}, false, err
		}
		found = append(found, tenants.Tenant{ID: id, Name: rowName, DefaultMediaPlane: defaultProvider, MediaPlaneProviderConfig: providerConfig})
	}
	if err := rows.Err(); err != nil {
		return tenants.Tenant{}, false, err
	}
	if len(found) > 1 {
		return tenants.Tenant{}, false, errors.New("multiple tenants use the bootstrap tenant name")
	}
	if len(found) == 0 {
		return tenants.Tenant{}, false, nil
	}
	return found[0], true, nil
}

func (t *postgresBootstrapTransaction) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	repository := postgres.NewTenantRepository(t.queries)
	return tenants.NewService(repository).CreateTenant(ctx, input)
}

func (t *postgresBootstrapTransaction) EnsureOwner(ctx context.Context, tenantID, userID utilities.ID) error {
	repository := postgres.NewMembershipRepository(t.queries)
	service := memberships.NewService(repository)
	membership, err := service.GetTenantMembershipForUser(ctx, tenantID, userID)
	if errors.Is(err, memberships.ErrMembershipNotFound) {
		_, err = service.CreateMembership(ctx, memberships.CreateMembershipInput{TenantID: tenantID, UserID: userID, Role: memberships.RoleOwner})
		return err
	}
	if err != nil {
		return err
	}
	if membership.Role == memberships.RoleOwner {
		return nil
	}
	_, err = service.UpdateTenantMembership(ctx, tenantID, membership.ID, memberships.UpdateMembershipInput{Role: memberships.RoleOwner})
	return err
}

func (t *postgresBootstrapTransaction) ActiveAPIKeyByName(ctx context.Context, tenantID utilities.ID, name string, now time.Time) (apikeys.Key, bool, error) {
	rows, err := t.tx.Query(ctx, `
select id::text, scopes, expires_at
from api_keys
where tenant_id = $1::uuid
  and name = $2
  and revoked_at is null
  and expires_at > $3
order by created_at desc, id desc
limit 2`, tenantID.String(), name, now)
	if err != nil {
		return apikeys.Key{}, false, err
	}
	defer rows.Close()

	var found []apikeys.Key
	for rows.Next() {
		var (
			keyID      string
			scopeNames []string
			expiresAt  time.Time
		)
		if err := rows.Scan(&keyID, &scopeNames, &expiresAt); err != nil {
			return apikeys.Key{}, false, err
		}
		id, err := utilities.ParseID(keyID)
		if err != nil {
			return apikeys.Key{}, false, err
		}
		scopes := make([]authentication.Scope, len(scopeNames))
		for index, scope := range scopeNames {
			scopes[index] = authentication.Scope(scope)
		}
		found = append(found, apikeys.Key{ID: id, TenantID: tenantID, Name: name, Scopes: scopes, ExpiresAt: expiresAt})
	}
	if err := rows.Err(); err != nil {
		return apikeys.Key{}, false, err
	}
	if len(found) > 1 {
		return apikeys.Key{}, false, errors.New("multiple active api keys use the bootstrap key name")
	}
	if len(found) == 0 {
		return apikeys.Key{}, false, nil
	}
	return found[0], true, nil
}

func (t *postgresBootstrapTransaction) CreateAPIKey(ctx context.Context, input apikeys.CreateInput, now time.Time) (apikeys.CreateResult, error) {
	repository := postgres.NewAPIKeyRepository(t.queries, t.tx)
	service := apikeys.NewService(repository, apikeys.Config{Now: func() time.Time { return now }})
	return service.Create(ctx, input)
}

func (t *postgresBootstrapTransaction) RoomBySlug(ctx context.Context, tenantID utilities.ID, slug string) (rooms.Room, bool, error) {
	var (
		roomID     string
		name       string
		status     string
		mediaPlane string
	)
	err := t.tx.QueryRow(ctx, `
select id::text, name, status, media_plane
from rooms
where tenant_id = $1::uuid and slug = $2`, tenantID.String(), slug).Scan(&roomID, &name, &status, &mediaPlane)
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Room{}, false, nil
	}
	if err != nil {
		return rooms.Room{}, false, err
	}
	id, err := utilities.ParseID(roomID)
	if err != nil {
		return rooms.Room{}, false, err
	}
	return rooms.Room{ID: id, TenantID: tenantID, Name: name, Status: status, Slug: slug, MediaPlane: mediaPlane}, true, nil
}

func (t *postgresBootstrapTransaction) CreateRoom(ctx context.Context, input rooms.CreateRoomInput) (rooms.Room, error) {
	repository := postgres.NewRoomRepository(t.queries)
	return rooms.NewService(repository).CreateRoom(ctx, input)
}

func (t *postgresBootstrapTransaction) Commit(ctx context.Context) error {
	if err := t.tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit meeting bootstrap: %w", err)
	}
	return nil
}

func (t *postgresBootstrapTransaction) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

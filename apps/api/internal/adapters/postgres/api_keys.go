package postgres

import (
	"context"

	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type APIKeyRepository struct {
	queries    apiKeyQuerier
	transactor apiKeyTransactor
	decorate   func(sqlc.Querier) sqlc.Querier
}

type apiKeyQuerier interface {
	GetActiveAPIKeyByPrefix(context.Context, string) (sqlc.GetActiveAPIKeyByPrefixRow, error)
	GetTenantAPIKey(context.Context, sqlc.GetTenantAPIKeyParams) (sqlc.GetTenantAPIKeyRow, error)
	ListTenantAPIKeys(context.Context, sqlc.ListTenantAPIKeysParams) ([]sqlc.ListTenantAPIKeysRow, error)
	TouchActiveAPIKeyLastUsed(context.Context, sqlc.TouchActiveAPIKeyLastUsedParams) error
}

type apiKeyTransactor interface {
	Begin(context.Context) (pgx.Tx, error)
}

func NewAPIKeyRepository(queries apiKeyQuerier, transactor apiKeyTransactor, decorators ...func(sqlc.Querier) sqlc.Querier) APIKeyRepository {
	var decorate func(sqlc.Querier) sqlc.Querier
	if len(decorators) > 0 {
		decorate = decorators[0]
	}
	return APIKeyRepository{queries: queries, transactor: transactor, decorate: decorate}
}

func (r APIKeyRepository) Create(ctx context.Context, input apikeys.CreateRecordInput) (apikeys.Record, error) {
	tx, queries, err := r.beginMutation(ctx)
	if err != nil {
		return apikeys.Record{}, err
	}
	defer tx.Rollback(ctx)

	row, err := queries.CreateAPIKey(ctx, sqlc.CreateAPIKeyParams{
		ID:              uuid(input.ID),
		TenantID:        uuid(input.TenantID),
		Name:            input.Name,
		Scopes:          apiKeyScopeStrings(input.Scopes),
		KeyHash:         input.KeyHash,
		KeyPrefix:       input.KeyPrefix,
		CreatedByUserID: uuid(input.CreatedByUserID),
		ExpiresAt:       pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
	})
	if uniqueConstraintViolation(err, "api_keys_key_prefix_key") {
		return apikeys.Record{}, apikeys.ErrPrefixConflict
	}
	if err != nil {
		return apikeys.Record{}, fmt.Errorf("create api key: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return apikeys.Record{}, fmt.Errorf("commit api key creation: %w", err)
	}

	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), nil
}

func (r APIKeyRepository) Get(ctx context.Context, tenantID, id utilities.ID) (apikeys.Record, error) {
	row, err := r.queries.GetTenantAPIKey(ctx, sqlc.GetTenantAPIKeyParams{
		TenantID: uuid(tenantID),
		ID:       uuid(id),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apikeys.Record{}, apikeys.ErrAPIKeyNotFound
	}
	if err != nil {
		return apikeys.Record{}, fmt.Errorf("get api key: %w", err)
	}

	return mapAPIKeyRow(row), nil
}

func (r APIKeyRepository) GetByPrefix(ctx context.Context, prefix string) (apikeys.Record, error) {
	row, err := r.queries.GetActiveAPIKeyByPrefix(ctx, prefix)
	if errors.Is(err, pgx.ErrNoRows) {
		return apikeys.Record{}, apikeys.ErrAPIKeyNotFound
	}
	if err != nil {
		return apikeys.Record{}, fmt.Errorf("get active api key by prefix: %w", err)
	}

	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), nil
}

func (r APIKeyRepository) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (apikeys.RecordList, error) {
	rows, err := r.queries.ListTenantAPIKeys(ctx, listTenantAPIKeysParams(tenantID, page))
	if err != nil {
		return apikeys.RecordList{}, fmt.Errorf("list api keys: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := apikeys.RecordList{
		Records: make([]apikeys.Record, 0, len(rows)),
		Page:    pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		list.Records = append(list.Records, mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)))
	}
	if hasMore && len(list.Records) > 0 {
		last := list.Records[len(list.Records)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	return list, nil
}

func (r APIKeyRepository) Rotate(ctx context.Context, input apikeys.RotateRecordInput) (apikeys.Record, error) {
	tx, queries, err := r.beginMutation(ctx)
	if err != nil {
		return apikeys.Record{}, err
	}
	defer tx.Rollback(ctx)

	row, err := queries.RotateActiveAPIKey(ctx, sqlc.RotateActiveAPIKeyParams{
		KeyHash:   input.KeyHash,
		KeyPrefix: input.KeyPrefix,
		ExpiresAt: pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
		RotatedAt: pgtype.Timestamptz{Time: input.RotatedAt, Valid: true},
		TenantID:  uuid(input.TenantID),
		ID:        uuid(input.ID),
	})
	if uniqueConstraintViolation(err, "api_keys_key_prefix_key") {
		return apikeys.Record{}, apikeys.ErrPrefixConflict
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apikeys.Record{}, apikeys.ErrAPIKeyNotFound
	}
	if err != nil {
		return apikeys.Record{}, fmt.Errorf("rotate api key: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return apikeys.Record{}, fmt.Errorf("commit api key rotation: %w", err)
	}

	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), nil
}

func (r APIKeyRepository) Revoke(ctx context.Context, tenantID, id utilities.ID, revokedAt time.Time) error {
	tx, queries, err := r.beginMutation(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = queries.RevokeActiveAPIKey(ctx, sqlc.RevokeActiveAPIKeyParams{
		RevokedAt: pgtype.Timestamptz{Time: revokedAt, Valid: true},
		TenantID:  uuid(tenantID),
		ID:        uuid(id),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apikeys.ErrAPIKeyNotFound
	}
	if err != nil {
		return fmt.Errorf("revoke api key: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit api key revocation: %w", err)
	}

	return nil
}

func (r APIKeyRepository) TouchLastUsed(ctx context.Context, usage apikeys.Usage) error {
	err := r.queries.TouchActiveAPIKeyLastUsed(ctx, sqlc.TouchActiveAPIKeyLastUsedParams{
		UsedAt:    pgtype.Timestamptz{Time: usage.UsedAt, Valid: true},
		IpAddress: validIPAddress(usage.IPAddress),
		ID:        uuid(usage.KeyID),
	})
	if err != nil {
		return fmt.Errorf("touch api key last used: %w", err)
	}
	return nil
}

var _ apikeys.Repository = APIKeyRepository{}

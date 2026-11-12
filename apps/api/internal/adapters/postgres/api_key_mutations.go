package postgres

import (
	"bytes"
	"context"

	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
)

type apiKeyMutationQuerier interface {
	CreateAPIKey(context.Context, sqlc.CreateAPIKeyParams) (sqlc.CreateAPIKeyRow, error)

	GetAPIKeyMutation(context.Context, sqlc.GetAPIKeyMutationParams) (sqlc.ApiKeyMutationRequest, error)
	GetTenantAPIKey(context.Context, sqlc.GetTenantAPIKeyParams) (sqlc.GetTenantAPIKeyRow, error)
	LinkAPIKeyMutation(context.Context, sqlc.LinkAPIKeyMutationParams) error
	RevokeActiveAPIKey(context.Context, sqlc.RevokeActiveAPIKeyParams) (pgtype.UUID, error)
	RotateActiveAPIKey(context.Context, sqlc.RotateActiveAPIKeyParams) (sqlc.RotateActiveAPIKeyRow, error)
	ReserveAPIKeyMutation(context.Context, sqlc.ReserveAPIKeyMutationParams) (sqlc.ApiKeyMutationRequest, error)
}

func (r APIKeyRepository) CreateIdempotent(ctx context.Context, input apikeys.CreateRecordInput) (apikeys.Record, bool, error) {
	tx, queries, err := r.beginMutation(ctx)
	if err != nil {
		return apikeys.Record{}, false, err
	}
	defer tx.Rollback(ctx)

	replayed, err := reserveAPIKeyMutation(ctx, queries, input, "create")
	if err != nil {
		return apikeys.Record{}, false, err
	}
	if replayed {
		row, err := queries.GetTenantAPIKey(ctx, sqlc.GetTenantAPIKeyParams{TenantID: uuid(input.TenantID), ID: uuid(input.ID)})
		if errors.Is(err, pgx.ErrNoRows) {
			// The reservation stores the canonical resource id. A caller-supplied
			// generated id is intentionally not trusted during replay.
			mutation, getErr := queries.GetAPIKeyMutation(ctx, sqlc.GetAPIKeyMutationParams{TenantID: uuid(input.TenantID), Operation: "create", RequestKey: input.RequestKey})
			if getErr != nil {
				return apikeys.Record{}, true, fmt.Errorf("get api key create replay: %w", getErr)
			}
			if !mutation.ApiKeyID.Valid {
				return apikeys.Record{}, true, errors.New("api key create replay has no resource")
			}
			row, err = queries.GetTenantAPIKey(ctx, sqlc.GetTenantAPIKeyParams{TenantID: mutation.TenantID, ID: mutation.ApiKeyID})
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return apikeys.Record{}, true, apikeys.ErrAPIKeyNotFound
		}
		if err != nil {
			return apikeys.Record{}, true, fmt.Errorf("get api key create replay resource: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return apikeys.Record{}, true, fmt.Errorf("commit api key create replay: %w", err)
		}
		return mapAPIKeyRow(row), true, nil
	}

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
		return apikeys.Record{}, false, apikeys.ErrPrefixConflict
	}
	if err != nil {
		return apikeys.Record{}, false, fmt.Errorf("create idempotent api key: %w", err)
	}
	if err := queries.LinkAPIKeyMutation(ctx, sqlc.LinkAPIKeyMutationParams{ApiKeyID: uuid(input.ID), TenantID: uuid(input.TenantID), Operation: "create", RequestKey: input.RequestKey}); err != nil {
		return apikeys.Record{}, false, fmt.Errorf("link api key create request: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return apikeys.Record{}, false, fmt.Errorf("commit idempotent api key creation: %w", err)
	}
	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), false, nil
}

func (r APIKeyRepository) RotateIdempotent(ctx context.Context, input apikeys.RotateRecordInput) (apikeys.Record, bool, error) {
	tx, queries, err := r.beginMutation(ctx)
	if err != nil {
		return apikeys.Record{}, false, err
	}
	defer tx.Rollback(ctx)

	replayed, err := reserveAPIKeyMutation(ctx, queries, apikeys.CreateRecordInput{
		TenantID: input.TenantID, RequestKey: input.RequestKey, RequestFingerprint: input.RequestFingerprint,
	}, "rotate")
	if err != nil {
		return apikeys.Record{}, false, err
	}
	if replayed {
		row, err := queries.GetTenantAPIKey(ctx, sqlc.GetTenantAPIKeyParams{TenantID: uuid(input.TenantID), ID: uuid(input.ID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return apikeys.Record{}, true, apikeys.ErrAPIKeyNotFound
		}
		if err != nil {
			return apikeys.Record{}, true, fmt.Errorf("get api key rotate replay: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return apikeys.Record{}, true, fmt.Errorf("commit api key rotate replay: %w", err)
		}
		return mapAPIKeyRow(row), true, nil
	}

	row, err := queries.RotateActiveAPIKey(ctx, sqlc.RotateActiveAPIKeyParams{
		KeyHash:   input.KeyHash,
		KeyPrefix: input.KeyPrefix,
		ExpiresAt: pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
		RotatedAt: pgtype.Timestamptz{Time: input.RotatedAt, Valid: true},
		TenantID:  uuid(input.TenantID),
		ID:        uuid(input.ID),
	})
	if uniqueConstraintViolation(err, "api_keys_key_prefix_key") {
		return apikeys.Record{}, false, apikeys.ErrPrefixConflict
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apikeys.Record{}, false, apikeys.ErrAPIKeyNotFound
	}
	if err != nil {
		return apikeys.Record{}, false, fmt.Errorf("rotate idempotent api key: %w", err)
	}
	if err := queries.LinkAPIKeyMutation(ctx, sqlc.LinkAPIKeyMutationParams{ApiKeyID: uuid(input.ID), TenantID: uuid(input.TenantID), Operation: "rotate", RequestKey: input.RequestKey}); err != nil {
		return apikeys.Record{}, false, fmt.Errorf("link api key rotate request: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return apikeys.Record{}, false, fmt.Errorf("commit idempotent api key rotation: %w", err)
	}
	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), false, nil
}

func reserveAPIKeyMutation(ctx context.Context, queries apiKeyMutationQuerier, input apikeys.CreateRecordInput, operation string) (bool, error) {
	_, err := queries.ReserveAPIKeyMutation(ctx, sqlc.ReserveAPIKeyMutationParams{
		TenantID: uuid(input.TenantID), Operation: operation, RequestKey: input.RequestKey,
		RequestFingerprint: input.RequestFingerprint[:],
	})
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("reserve api key %s request: %w", operation, err)
	}
	existing, err := queries.GetAPIKeyMutation(ctx, sqlc.GetAPIKeyMutationParams{TenantID: uuid(input.TenantID), Operation: operation, RequestKey: input.RequestKey})
	if err != nil {
		return false, fmt.Errorf("get api key %s request: %w", operation, err)
	}
	if !bytes.Equal(existing.RequestFingerprint, input.RequestFingerprint[:]) {
		return false, apikeys.ErrIdempotencyConflict
	}
	return true, nil
}

func (r APIKeyRepository) beginMutation(ctx context.Context) (pgx.Tx, apiKeyMutationQuerier, error) {
	if r.transactor == nil {
		return nil, nil, errors.New("api key transaction unavailable")
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin api key transaction: %w", err)
	}
	var queries sqlc.Querier = sqlc.New(tx)
	if r.decorate != nil {
		queries = r.decorate(queries)
	}
	return tx, queries, nil
}

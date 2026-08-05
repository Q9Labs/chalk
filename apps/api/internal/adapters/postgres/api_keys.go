package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
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

type apiKeyMutationQuerier interface {
	CreateAPIKey(context.Context, sqlc.CreateAPIKeyParams) (sqlc.CreateAPIKeyRow, error)
	CreateAuditLog(context.Context, sqlc.CreateAuditLogParams) (sqlc.AuditLog, error)
	GetAPIKeyMutation(context.Context, sqlc.GetAPIKeyMutationParams) (sqlc.ApiKeyMutationRequest, error)
	GetTenantAPIKey(context.Context, sqlc.GetTenantAPIKeyParams) (sqlc.GetTenantAPIKeyRow, error)
	LinkAPIKeyMutation(context.Context, sqlc.LinkAPIKeyMutationParams) error
	RevokeActiveAPIKey(context.Context, sqlc.RevokeActiveAPIKeyParams) (pgtype.UUID, error)
	RotateActiveAPIKey(context.Context, sqlc.RotateActiveAPIKeyParams) (sqlc.RotateActiveAPIKeyRow, error)
	ReserveAPIKeyMutation(context.Context, sqlc.ReserveAPIKeyMutationParams) (sqlc.ApiKeyMutationRequest, error)
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
	if err := createAPIKeyAudit(ctx, queries, input.TenantID, input.ID, "api_key.created"); err != nil {
		return apikeys.Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return apikeys.Record{}, fmt.Errorf("commit api key creation: %w", err)
	}

	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), nil
}

// CreateIdempotent reserves the request before creating the key. The
// reservation stores a fingerprint and resource id only; a replay returns the
// existing metadata with no credential material.
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
	if err := createAPIKeyAudit(ctx, queries, input.TenantID, input.ID, "api_key.created"); err != nil {
		return apikeys.Record{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return apikeys.Record{}, false, fmt.Errorf("commit idempotent api key creation: %w", err)
	}
	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), false, nil
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
	if err := createAPIKeyAudit(ctx, queries, input.TenantID, input.ID, "api_key.rotated"); err != nil {
		return apikeys.Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return apikeys.Record{}, fmt.Errorf("commit api key rotation: %w", err)
	}

	return mapAPIKeyRow(sqlc.GetTenantAPIKeyRow(row)), nil
}

// RotateIdempotent applies the same metadata-only replay rule to rotations.
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
	if err := createAPIKeyAudit(ctx, queries, input.TenantID, input.ID, "api_key.rotated"); err != nil {
		return apikeys.Record{}, false, err
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
	if err := createAPIKeyAudit(ctx, queries, tenantID, id, "api_key.revoked"); err != nil {
		return err
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

func listTenantAPIKeysParams(tenantID utilities.ID, page pagination.PageRequest) sqlc.ListTenantAPIKeysParams {
	params := sqlc.ListTenantAPIKeysParams{
		TenantID: uuid(tenantID),
		PageSize: int32(page.Size() + 1),
	}
	if cursor := page.Cursor(); cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
		params.CursorID = uuid(cursor.ID)
	}
	return params
}

func mapAPIKeyRow(row sqlc.GetTenantAPIKeyRow) apikeys.Record {
	return apikeys.Record{
		KeyHash: row.KeyHash,
		Key: apikeys.Key{
			ID:              utilities.IDFromBytes(row.ID.Bytes),
			TenantID:        utilities.IDFromBytes(row.TenantID.Bytes),
			Name:            row.Name,
			Scopes:          apiKeyScopes(row.Scopes),
			Prefix:          row.KeyPrefix,
			CreatedByUserID: nullableID(row.CreatedByUserID),
			LastUsedAt:      nullableTimestamp(row.LastUsedAt),
			RevokedAt:       nullableTimestamp(row.RevokedAt),
			ExpiresAt:       timestamp(row.ExpiresAt),
			UpdatedAt:       timestamp(row.UpdatedAt),
			CreatedAt:       timestamp(row.CreatedAt),
		},
	}
}

func apiKeyScopeStrings(scopes []authentication.Scope) []string {
	values := make([]string, len(scopes))
	for index, scope := range scopes {
		values[index] = string(scope)
	}
	return values
}

func apiKeyScopes(values []string) []authentication.Scope {
	scopes := make([]authentication.Scope, len(values))
	for index, value := range values {
		scopes[index] = authentication.Scope(value)
	}
	return scopes
}

func validIPAddress(address netip.Addr) *netip.Addr {
	if !address.IsValid() {
		return nil
	}
	return &address
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

func createAPIKeyAudit(ctx context.Context, queries apiKeyMutationQuerier, tenantID, keyID utilities.ID, action string) error {
	auditID, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("create api key audit id: %w", err)
	}
	actorType, actorUserID, details := apiKeyAuditActor(ctx)
	encodedDetails, err := json.Marshal(details)
	if err != nil {
		return fmt.Errorf("marshal api key audit details: %w", err)
	}
	_, err = queries.CreateAuditLog(ctx, sqlc.CreateAuditLogParams{
		ID:           uuid(auditID),
		TenantID:     uuid(tenantID),
		ActorUserID:  nullableUUID(actorUserID),
		ActorType:    actorType,
		Action:       action,
		ResourceType: pgtype.Text{String: "api_key", Valid: true},
		ResourceID:   uuid(keyID),
		Details:      encodedDetails,
		Outcome:      auditlogs.OutcomeSuccess,
	})
	if err != nil {
		return fmt.Errorf("create api key audit log: %w", err)
	}
	return nil
}

func apiKeyAuditActor(ctx context.Context) (string, utilities.ID, map[string]string) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return auditlogs.ActorSystem, utilities.ID{}, map[string]string{}
	}
	actorType, actorUserID := auditlogs.PrincipalActor(principal)
	if principal.Kind == authentication.PrincipalAPIKey {
		return actorType, actorUserID, map[string]string{"actor_api_key_id": principal.APIKeyID.String()}
	}
	return actorType, actorUserID, map[string]string{}
}

var _ apikeys.Repository = APIKeyRepository{}

package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type IntegrationRepository struct {
	queries integrationQuerier
}

type integrationQuerier interface {
	CreateIntegrationConnection(ctx context.Context, arg sqlc.CreateIntegrationConnectionParams) (sqlc.IntegrationConnection, error)
	GetIntegrationConnection(ctx context.Context, arg sqlc.GetIntegrationConnectionParams) (sqlc.IntegrationConnection, error)
	GetIntegrationConnectionByExternalRef(ctx context.Context, arg sqlc.GetIntegrationConnectionByExternalRefParams) (sqlc.IntegrationConnection, error)
	ListIntegrationConnections(ctx context.Context, arg sqlc.ListIntegrationConnectionsParams) ([]sqlc.IntegrationConnection, error)
	UpdateIntegrationConnection(ctx context.Context, arg sqlc.UpdateIntegrationConnectionParams) (sqlc.IntegrationConnection, error)
	MarkIntegrationConnectionUsed(ctx context.Context, arg sqlc.MarkIntegrationConnectionUsedParams) (sqlc.IntegrationConnection, error)
	CreateAuditLog(ctx context.Context, arg sqlc.CreateAuditLogParams) (sqlc.AuditLog, error)
}

func NewIntegrationRepository(queries integrationQuerier) IntegrationRepository {
	return IntegrationRepository{queries: queries}
}

func (r IntegrationRepository) CreateConnection(ctx context.Context, input integrations.CreateConnectionInput) (integrations.Connection, error) {
	row, err := r.queries.CreateIntegrationConnection(ctx, sqlc.CreateIntegrationConnectionParams{
		ID:                    uuid(input.ID),
		TenantID:              uuid(input.TenantID),
		UserID:                uuid(input.UserID),
		Provider:              string(input.Provider),
		Service:               string(input.Service),
		ExternalAccountRef:    input.ExternalAccountRef,
		ExternalAuthConfigRef: text(input.ExternalAuthConfigRef),
		Status:                string(input.Status),
		AccountLabel:          text(input.AccountLabel),
		AccountEmail:          text(input.AccountEmail),
		Scopes:                nonNilStrings(input.Scopes),
		Metadata:              nil,
		ConnectedAt:           nullableTime(input.ConnectedAt),
		ExpiresAt:             nullableTime(input.ExpiresAt),
	})
	if uniqueViolation(err) {
		return integrations.Connection{}, integrations.ErrConnectionAlreadyExists
	}
	if err != nil {
		return integrations.Connection{}, fmt.Errorf("create integration connection: %w", err)
	}

	return mapIntegrationConnection(row), nil
}

func (r IntegrationRepository) GetConnection(ctx context.Context, tenantID utilities.ID, id utilities.ID) (integrations.Connection, error) {
	row, err := r.queries.GetIntegrationConnection(ctx, sqlc.GetIntegrationConnectionParams{
		TenantID: uuid(tenantID),
		ID:       uuid(id),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return integrations.Connection{}, integrations.ErrConnectionNotFound
	}
	if err != nil {
		return integrations.Connection{}, fmt.Errorf("get integration connection: %w", err)
	}

	return mapIntegrationConnection(row), nil
}

func (r IntegrationRepository) GetConnectionByExternalRef(ctx context.Context, tenantID utilities.ID, provider integrations.ProviderName, service integrations.ServiceID, externalAccountRef string) (integrations.Connection, error) {
	row, err := r.queries.GetIntegrationConnectionByExternalRef(ctx, sqlc.GetIntegrationConnectionByExternalRefParams{
		TenantID:           uuid(tenantID),
		Provider:           string(provider),
		Service:            string(service),
		ExternalAccountRef: externalAccountRef,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return integrations.Connection{}, integrations.ErrConnectionNotFound
	}
	if err != nil {
		return integrations.Connection{}, fmt.Errorf("get integration connection by external ref: %w", err)
	}

	return mapIntegrationConnection(row), nil
}

func (r IntegrationRepository) ListConnections(ctx context.Context, input integrations.ListConnectionsInput) (integrations.ConnectionList, error) {
	rows, err := r.queries.ListIntegrationConnections(ctx, listIntegrationConnectionsParams(input))
	if err != nil {
		return integrations.ConnectionList{}, fmt.Errorf("list integration connections: %w", err)
	}

	size := input.Page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	response := integrations.ConnectionList{
		Connections: make([]integrations.Connection, 0, len(rows)),
		Page: pagination.Page{
			PageSize: size,
			HasMore:  hasMore,
		},
	}
	for _, row := range rows {
		response.Connections = append(response.Connections, mapIntegrationConnection(row))
	}
	if hasMore && len(response.Connections) > 0 {
		last := response.Connections[len(response.Connections)-1]
		response.Page.NextCursor = &pagination.Cursor{
			CreatedAt: last.CreatedAt,
			ID:        last.ID,
		}
	}

	return response, nil
}

func (r IntegrationRepository) UpdateConnection(ctx context.Context, input integrations.UpdateConnectionInput) (integrations.Connection, error) {
	row, err := r.queries.UpdateIntegrationConnection(ctx, sqlc.UpdateIntegrationConnectionParams{
		Status:       string(input.Status),
		AccountLabel: text(input.AccountLabel),
		AccountEmail: text(input.AccountEmail),
		Scopes:       nonNilStrings(input.Scopes),
		Metadata:     nil,
		ConnectedAt:  nullableTime(input.ConnectedAt),
		ExpiresAt:    nullableTime(input.ExpiresAt),
		RevokedAt:    nullableTime(input.RevokedAt),
		TenantID:     uuid(input.TenantID),
		ID:           uuid(input.ID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return integrations.Connection{}, integrations.ErrConnectionNotFound
	}
	if err != nil {
		return integrations.Connection{}, fmt.Errorf("update integration connection: %w", err)
	}

	return mapIntegrationConnection(row), nil
}

func (r IntegrationRepository) MarkConnectionUsed(ctx context.Context, tenantID utilities.ID, id utilities.ID) (integrations.Connection, error) {
	row, err := r.queries.MarkIntegrationConnectionUsed(ctx, sqlc.MarkIntegrationConnectionUsedParams{
		TenantID: uuid(tenantID),
		ID:       uuid(id),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return integrations.Connection{}, integrations.ErrConnectionNotFound
	}
	if err != nil {
		return integrations.Connection{}, fmt.Errorf("mark integration connection used: %w", err)
	}

	return mapIntegrationConnection(row), nil
}

func (r IntegrationRepository) CreateAuditLog(ctx context.Context, input integrations.AuditLogInput) error {
	details, err := json.Marshal(map[string]string{
		"provider": "composio",
	})
	if err != nil {
		return fmt.Errorf("marshal integration audit details: %w", err)
	}

	_, err = r.queries.CreateAuditLog(ctx, sqlc.CreateAuditLogParams{
		ID:          uuid(input.ID),
		TenantID:    uuid(input.TenantID),
		ActorUserID: nullableUUID(input.ActorUserID),
		ActorType:   "user",
		Action:      input.Action,
		ResourceType: pgtype.Text{
			String: "integration_connection",
			Valid:  true,
		},
		ResourceID:   uuid(input.ResourceID),
		Details:      details,
		Outcome:      input.Outcome,
		ErrorCode:    text(input.ErrorCode),
		ErrorMessage: pgtype.Text{},
	})
	if err != nil {
		return fmt.Errorf("create integration audit log: %w", err)
	}
	return nil
}

func listIntegrationConnectionsParams(input integrations.ListConnectionsInput) sqlc.ListIntegrationConnectionsParams {
	params := sqlc.ListIntegrationConnectionsParams{
		TenantID:    uuid(input.TenantID),
		UserSet:     !input.UserID.IsZero(),
		UserID:      uuid(input.UserID),
		ProviderSet: input.Provider != "",
		Provider:    string(input.Provider),
		ServiceSet:  input.Service != "",
		Service:     string(input.Service),
		StatusSet:   input.Status != "",
		Status:      string(input.Status),
		PageSize:    int32(input.Page.Size() + 1),
	}

	cursor := input.Page.Cursor()
	if cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
		params.CursorID = uuid(cursor.ID)
	}

	return params
}

func mapIntegrationConnection(row sqlc.IntegrationConnection) integrations.Connection {
	return integrations.Connection{
		ID:                    utilities.IDFromBytes(row.ID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		UserID:                utilities.IDFromBytes(row.UserID.Bytes),
		Provider:              integrations.ProviderName(row.Provider),
		Service:               integrations.ServiceID(row.Service),
		ExternalAccountRef:    row.ExternalAccountRef,
		ExternalAuthConfigRef: nullableText(row.ExternalAuthConfigRef),
		Status:                integrations.ConnectionStatus(row.Status),
		AccountLabel:          nullableText(row.AccountLabel),
		AccountEmail:          nullableText(row.AccountEmail),
		Scopes:                row.Scopes,
		ConnectedAt:           nullableTimestamp(row.ConnectedAt),
		ExpiresAt:             nullableTimestamp(row.ExpiresAt),
		LastUsedAt:            nullableTimestamp(row.LastUsedAt),
		RevokedAt:             nullableTimestamp(row.RevokedAt),
		UpdatedAt:             timestamp(row.UpdatedAt),
		CreatedAt:             timestamp(row.CreatedAt),
	}
}

func nullableTime(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nullableUUID(id utilities.ID) pgtype.UUID {
	if id.IsZero() {
		return pgtype.UUID{}
	}
	return uuid(id)
}

var _ integrations.Repository = IntegrationRepository{}

package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
)

func TestIntegrationRepositoryCreateConnectionSendsEmptyScopes(t *testing.T) {
	querier := &integrationQuerier{}
	repository := postgres.NewIntegrationRepository(querier)

	_, err := repository.CreateConnection(context.Background(), integrations.CreateConnectionInput{
		ID:                 mustTenantID(t, "33333333-3333-4333-8333-333333333333"),
		TenantID:           mustTenantID(t, tenantID),
		UserID:             mustTenantID(t, "22222222-2222-4222-8222-222222222222"),
		Provider:           integrations.ProviderComposio,
		Service:            "slack",
		ExternalAccountRef: "ca_test",
		Status:             integrations.StatusPending,
	})
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}
	if querier.createArg.Scopes == nil {
		t.Fatal("scopes arg is nil, want empty slice")
	}
	if len(querier.createArg.Scopes) != 0 {
		t.Fatalf("scopes arg = %v, want empty", querier.createArg.Scopes)
	}
}

func TestIntegrationRepositoryUpdateConnectionSendsEmptyScopes(t *testing.T) {
	querier := &integrationQuerier{}
	repository := postgres.NewIntegrationRepository(querier)

	_, err := repository.UpdateConnection(context.Background(), integrations.UpdateConnectionInput{
		ID:       mustTenantID(t, "33333333-3333-4333-8333-333333333333"),
		TenantID: mustTenantID(t, tenantID),
		Status:   integrations.StatusActive,
	})
	if err != nil {
		t.Fatalf("update connection: %v", err)
	}
	if querier.updateArg.Scopes == nil {
		t.Fatal("scopes arg is nil, want empty slice")
	}
	if len(querier.updateArg.Scopes) != 0 {
		t.Fatalf("scopes arg = %v, want empty", querier.updateArg.Scopes)
	}
}

func TestIntegrationRepositoryCreateConnectionMapsDuplicateProviderRef(t *testing.T) {
	repository := postgres.NewIntegrationRepository(&integrationQuerier{
		createErr: &pgconn.PgError{Code: "23505"},
	})

	_, err := repository.CreateConnection(context.Background(), integrations.CreateConnectionInput{
		ID:                 mustTenantID(t, "33333333-3333-4333-8333-333333333333"),
		TenantID:           mustTenantID(t, tenantID),
		UserID:             mustTenantID(t, "22222222-2222-4222-8222-222222222222"),
		Provider:           integrations.ProviderComposio,
		Service:            "slack",
		ExternalAccountRef: "ca_test",
		Status:             integrations.StatusPending,
	})
	if !errors.Is(err, integrations.ErrConnectionAlreadyExists) {
		t.Fatalf("error = %v, want connection already exists", err)
	}
}

func TestIntegrationRepositoryCreateAuditLogSendsNullActorForTenantScopedAction(t *testing.T) {
	querier := &integrationQuerier{}
	repository := postgres.NewIntegrationRepository(querier)

	err := repository.CreateAuditLog(context.Background(), integrations.AuditLogInput{
		ID:         mustTenantID(t, "33333333-3333-4333-8333-333333333333"),
		TenantID:   mustTenantID(t, tenantID),
		ActorType:  "api_key",
		Action:     "integration.connection.disabled",
		ResourceID: mustTenantID(t, "44444444-4444-4444-8444-444444444444"),
		Outcome:    "success",
	})
	if err != nil {
		t.Fatalf("create audit log: %v", err)
	}
	if querier.auditArg.ActorUserID.Valid {
		t.Fatalf("actor user id valid = true, want SQL NULL")
	}
	if querier.auditArg.ActorType != "api_key" {
		t.Fatalf("actor type = %q, want api_key", querier.auditArg.ActorType)
	}
}

type integrationQuerier struct {
	createArg sqlc.CreateIntegrationConnectionParams
	updateArg sqlc.UpdateIntegrationConnectionParams
	auditArg  sqlc.CreateAuditLogParams
	createErr error
}

func (q *integrationQuerier) CreateIntegrationConnection(ctx context.Context, arg sqlc.CreateIntegrationConnectionParams) (sqlc.IntegrationConnection, error) {
	q.createArg = arg
	if q.createErr != nil {
		return sqlc.IntegrationConnection{}, q.createErr
	}
	return integrationConnectionRow(arg.ID, arg.TenantID, arg.UserID, arg.Provider, arg.Service, arg.ExternalAccountRef, arg.Status, arg.Scopes), nil
}

func (q *integrationQuerier) GetIntegrationConnection(ctx context.Context, arg sqlc.GetIntegrationConnectionParams) (sqlc.IntegrationConnection, error) {
	return sqlc.IntegrationConnection{}, nil
}

func (q *integrationQuerier) GetIntegrationConnectionByExternalRef(ctx context.Context, arg sqlc.GetIntegrationConnectionByExternalRefParams) (sqlc.IntegrationConnection, error) {
	return sqlc.IntegrationConnection{}, nil
}

func (q *integrationQuerier) ListIntegrationConnections(ctx context.Context, arg sqlc.ListIntegrationConnectionsParams) ([]sqlc.IntegrationConnection, error) {
	return nil, nil
}

func (q *integrationQuerier) UpdateIntegrationConnection(ctx context.Context, arg sqlc.UpdateIntegrationConnectionParams) (sqlc.IntegrationConnection, error) {
	q.updateArg = arg
	return integrationConnectionRow(arg.ID, arg.TenantID, arg.TenantID, string(integrations.ProviderComposio), "slack", "ca_test", arg.Status, arg.Scopes), nil
}

func (q *integrationQuerier) MarkIntegrationConnectionUsed(ctx context.Context, arg sqlc.MarkIntegrationConnectionUsedParams) (sqlc.IntegrationConnection, error) {
	return sqlc.IntegrationConnection{}, nil
}

func (q *integrationQuerier) CreateAuditLog(ctx context.Context, arg sqlc.CreateAuditLogParams) (sqlc.AuditLog, error) {
	q.auditArg = arg
	return sqlc.AuditLog{}, nil
}

func integrationConnectionRow(id pgtype.UUID, tenantID pgtype.UUID, userID pgtype.UUID, provider string, service string, externalAccountRef string, status string, scopes []string) sqlc.IntegrationConnection {
	now := timestamp(time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC))
	return sqlc.IntegrationConnection{
		ID:                 id,
		TenantID:           tenantID,
		UserID:             userID,
		Provider:           provider,
		Service:            service,
		ExternalAccountRef: externalAccountRef,
		Status:             status,
		Scopes:             scopes,
		UpdatedAt:          now,
		CreatedAt:          now,
	}
}

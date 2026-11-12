package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
)

type MCPOAuthRepository struct {
	pool mcpOAuthPool
}

type mcpOAuthPool interface {
	sqlc.DBTX
	Begin(context.Context) (pgx.Tx, error)
}

func NewMCPOAuthRepository(pool mcpOAuthPool) MCPOAuthRepository {
	return MCPOAuthRepository{pool: pool}
}

func pgTime(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func firstScope(scopes []string) string {
	if len(scopes) == 0 {
		return ""
	}
	return scopes[0]
}

func (r MCPOAuthRepository) CreateClient(ctx context.Context, client mcpauth.Client) error {
	return sqlc.New(r.pool).CreateMCPOAuthClient(ctx, sqlc.CreateMCPOAuthClientParams{ID: uuid(client.ID), ClientID: client.ClientID, ClientName: client.Name, RedirectUris: client.RedirectURIs})
}

func (r MCPOAuthRepository) GetClient(ctx context.Context, clientID string) (mcpauth.Client, error) {
	row, err := sqlc.New(r.pool).GetMCPOAuthClientByPublicID(ctx, clientID)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpauth.Client{}, mcpauth.ErrClientNotFound
	}
	if err != nil {
		return mcpauth.Client{}, fmt.Errorf("get mcp oauth client: %w", err)
	}
	return mcpauth.Client{ID: nullableID(row.ID), ClientID: row.ClientID, Name: row.ClientName, RedirectURIs: row.RedirectUris}, nil
}

func (r MCPOAuthRepository) PruneStale(ctx context.Context, cutoff time.Time) error {
	return sqlc.New(r.pool).DeleteStaleMCPOAuthRegistrations(ctx, pgTime(cutoff))
}

func (r MCPOAuthRepository) CreateAuthorizationRequest(ctx context.Context, handleHash string, client mcpauth.Client, request mcpauth.AuthorizationRequest) error {
	return sqlc.New(r.pool).CreateMCPOAuthAuthorizationRequest(ctx, sqlc.CreateMCPOAuthAuthorizationRequestParams{
		RequestHash: handleHash, ClientID: uuid(client.ID), RedirectUri: request.RedirectURI, RedirectUriSupplied: request.RedirectURISupplied, State: stateText(request.State),
		CodeChallenge: request.CodeChallenge, Scopes: []string{request.Scope}, Resource: request.Resource, ExpiresAt: pgTime(request.ExpiresAt),
	})
}

func stateText(state string) pgtype.Text {
	if state == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: state, Valid: true}
}

func (r MCPOAuthRepository) GetOpenAuthorizationRequest(ctx context.Context, handleHash string, now time.Time) (mcpauth.AuthorizationRequest, error) {
	row, err := sqlc.New(r.pool).GetOpenMCPOAuthAuthorizationRequest(ctx, sqlc.GetOpenMCPOAuthAuthorizationRequestParams{RequestHash: handleHash, Now: pgTime(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpauth.AuthorizationRequest{}, mcpauth.ErrRequestNotFound
	}
	if err != nil {
		return mcpauth.AuthorizationRequest{}, fmt.Errorf("get mcp oauth authorization request: %w", err)
	}
	return mcpauth.AuthorizationRequest{
		ClientID: row.ClientID, ClientName: row.ClientName, RedirectURI: row.RedirectUri, RedirectURISupplied: row.RedirectUriSupplied, State: nullableString(row.State),
		CodeChallenge: row.CodeChallenge, Scope: firstScope(row.Scopes), Resource: row.Resource, ExpiresAt: row.ExpiresAt.Time,
	}, nil
}

func (r MCPOAuthRepository) ApproveAuthorizationRequest(ctx context.Context, input mcpauth.ApproveRecord) (mcpauth.AuthorizationRequest, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return mcpauth.AuthorizationRequest{}, fmt.Errorf("begin mcp oauth approval: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	decided, err := queries.DecideMCPOAuthAuthorizationRequest(ctx, sqlc.DecideMCPOAuthAuthorizationRequestParams{RequestHash: input.HandleHash, Now: pgTime(input.Now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpauth.AuthorizationRequest{}, mcpauth.ErrRequestNotFound
	}
	if err != nil {
		return mcpauth.AuthorizationRequest{}, fmt.Errorf("decide mcp oauth authorization request: %w", err)
	}
	if err := queries.CreateMCPOAuthGrant(ctx, sqlc.CreateMCPOAuthGrantParams{
		ID: uuid(input.GrantID), TenantID: uuid(input.TenantID), ClientID: decided.ClientRowID, Scopes: []string{input.Scope},
		Resource: decided.Resource, ApprovedByServiceID: input.ServiceID,
	}); err != nil {
		return mcpauth.AuthorizationRequest{}, fmt.Errorf("create mcp oauth grant: %w", err)
	}
	if err := queries.CreateMCPOAuthCode(ctx, sqlc.CreateMCPOAuthCodeParams{
		CodeHash: input.CodeHash, GrantID: uuid(input.GrantID), RedirectUri: decided.RedirectUri, RedirectUriSupplied: decided.RedirectUriSupplied, CodeChallenge: decided.CodeChallenge, ExpiresAt: pgTime(input.CodeExpiry),
	}); err != nil {
		return mcpauth.AuthorizationRequest{}, fmt.Errorf("create mcp oauth code: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mcpauth.AuthorizationRequest{}, fmt.Errorf("commit mcp oauth approval: %w", err)
	}
	return mcpauth.AuthorizationRequest{RedirectURI: decided.RedirectUri, State: nullableString(decided.State), Resource: decided.Resource}, nil
}

func (r MCPOAuthRepository) DenyAuthorizationRequest(ctx context.Context, handleHash string, now time.Time) (mcpauth.AuthorizationRequest, error) {
	decided, err := sqlc.New(r.pool).DecideMCPOAuthAuthorizationRequest(ctx, sqlc.DecideMCPOAuthAuthorizationRequestParams{RequestHash: handleHash, Now: pgTime(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpauth.AuthorizationRequest{}, mcpauth.ErrRequestNotFound
	}
	if err != nil {
		return mcpauth.AuthorizationRequest{}, fmt.Errorf("deny mcp oauth authorization request: %w", err)
	}
	return mcpauth.AuthorizationRequest{RedirectURI: decided.RedirectUri, State: nullableString(decided.State)}, nil
}

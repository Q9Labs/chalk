package mcpauth

import (
	"context"
	"log/slog"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Revoke implements RFC 7009. It succeeds for unknown tokens so callers learn nothing.
func (s Service) Revoke(ctx context.Context, rawToken, clientID string) error {
	if rawToken == "" || len(rawToken) > 128 {
		return nil
	}
	return s.repository.RevokeByToken(ctx, hashSecret(rawToken), clientID, s.config.Now())
}

// Authenticate verifies an access token for the MCP resource.
func (s Service) Authenticate(ctx context.Context, rawToken string) (authentication.Principal, error) {
	hash, ok := HashAccessToken(rawToken)
	if !ok {
		return authentication.Principal{}, ErrInvalidAccessToken
	}
	record, err := s.repository.AuthenticateAccessToken(ctx, hash, s.config.Now())
	if err != nil {
		return authentication.Principal{}, err
	}
	// Audience binding: both the token and its grant must name this MCP resource.
	if record.TokenResource != s.config.Resource() || record.GrantResource != s.config.Resource() || record.TenantID.IsZero() {
		return authentication.Principal{}, ErrInvalidAccessToken
	}
	return authentication.Principal{Kind: authentication.PrincipalOAuth, TenantID: record.TenantID, GrantID: record.GrantID, Scopes: AuthenticationScopes(record.Scope)}, nil
}

func (s Service) ListGrants(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (GrantList, error) {
	return s.repository.ListGrants(ctx, tenantID, page)
}

func (s Service) RevokeGrant(ctx context.Context, tenantID, grantID utilities.ID) error {
	if err := s.repository.RevokeTenantGrant(ctx, tenantID, grantID, s.config.Now()); err != nil {
		return err
	}
	slog.InfoContext(ctx, "MCP OAuth grant revoked", "event", "mcp.oauth.grant_revoked", "grant_id", grantID.String(), "tenant_id", tenantID.String())
	return nil
}

func hashHandle(handle string) (string, bool) {
	if !strings.HasPrefix(handle, handlePrefix) || len(handle) > 128 {
		return "", false
	}
	return hashSecret(handle), true
}

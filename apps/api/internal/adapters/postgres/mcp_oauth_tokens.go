package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r MCPOAuthRepository) RedeemCode(ctx context.Context, codeHash string, now time.Time, verify func(mcpauth.Redemption) error, tokens []mcpauth.NewToken) (mcpauth.Grant, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return mcpauth.Grant{}, fmt.Errorf("begin mcp oauth code redemption: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	code, err := queries.ConsumeMCPOAuthCode(ctx, sqlc.ConsumeMCPOAuthCodeParams{CodeHash: codeHash, Now: pgTime(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpauth.Grant{}, rejectUnusableCode(ctx, tx, queries, codeHash, now)
	}
	if err != nil {
		return mcpauth.Grant{}, fmt.Errorf("consume mcp oauth code: %w", err)
	}
	grant, err := loadGrant(ctx, queries, nullableID(code.GrantID))
	if err != nil {
		return mcpauth.Grant{}, err
	}
	if grant.revoked {
		return mcpauth.Grant{}, commitThen(ctx, tx, mcpauth.ErrInvalidGrant)
	}
	if err := verify(mcpauth.Redemption{Grant: grant.Grant, RedirectURI: code.RedirectUri, RedirectURISupplied: code.RedirectUriSupplied, CodeChallenge: code.CodeChallenge}); err != nil {
		// The code stays consumed: a failed attempt burns it.
		return mcpauth.Grant{}, commitThen(ctx, tx, err)
	}
	if err := insertTokens(ctx, queries, grant.ID, tokens, now); err != nil {
		return mcpauth.Grant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return mcpauth.Grant{}, fmt.Errorf("commit mcp oauth code redemption: %w", err)
	}
	return grant.Grant, nil
}

// rejectUnusableCode explains why a code cannot be consumed. A code that was
// already consumed means it leaked or a client replayed it, so its grant dies.
func rejectUnusableCode(ctx context.Context, tx pgx.Tx, queries *sqlc.Queries, codeHash string, now time.Time) error {
	existing, err := queries.GetMCPOAuthCodeGrant(ctx, codeHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpauth.ErrInvalidGrant
	}
	if err != nil {
		return fmt.Errorf("get mcp oauth code: %w", err)
	}
	if !existing.ConsumedAt.Valid {
		return mcpauth.ErrInvalidGrant
	}
	if _, err := queries.RevokeMCPOAuthGrant(ctx, sqlc.RevokeMCPOAuthGrantParams{ID: existing.GrantID, Now: pgTime(now)}); err != nil {
		return fmt.Errorf("revoke grant after code reuse: %w", err)
	}
	return commitThen(ctx, tx, mcpauth.ErrGrantReused)
}

func (r MCPOAuthRepository) RotateRefreshToken(ctx context.Context, tokenHash, clientID string, now time.Time, tokens []mcpauth.NewToken) (mcpauth.Grant, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return mcpauth.Grant{}, fmt.Errorf("begin mcp oauth refresh: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	used, err := queries.ConsumeMCPOAuthRefreshToken(ctx, sqlc.ConsumeMCPOAuthRefreshTokenParams{TokenHash: tokenHash, Now: pgTime(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		existing, getErr := queries.GetMCPOAuthRefreshToken(ctx, tokenHash)
		if errors.Is(getErr, pgx.ErrNoRows) || getErr == nil && !existing.UsedAt.Valid {
			return mcpauth.Grant{}, mcpauth.ErrInvalidGrant
		}
		if getErr != nil {
			return mcpauth.Grant{}, fmt.Errorf("get mcp oauth refresh token: %w", getErr)
		}
		if _, err := queries.RevokeMCPOAuthGrant(ctx, sqlc.RevokeMCPOAuthGrantParams{ID: existing.GrantID, Now: pgTime(now)}); err != nil {
			return mcpauth.Grant{}, fmt.Errorf("revoke grant after refresh reuse: %w", err)
		}
		return mcpauth.Grant{}, commitThen(ctx, tx, mcpauth.ErrGrantReused)
	}
	if err != nil {
		return mcpauth.Grant{}, fmt.Errorf("consume mcp oauth refresh token: %w", err)
	}
	grant, err := loadGrant(ctx, queries, nullableID(used.GrantID))
	if err != nil {
		return mcpauth.Grant{}, err
	}
	if grant.revoked {
		return mcpauth.Grant{}, mcpauth.ErrInvalidGrant
	}
	if grant.ClientID != clientID {
		if _, err := queries.RevokeMCPOAuthGrant(ctx, sqlc.RevokeMCPOAuthGrantParams{ID: uuid(grant.ID), Now: pgTime(now)}); err != nil {
			return mcpauth.Grant{}, fmt.Errorf("revoke grant after cross-client refresh: %w", err)
		}
		return mcpauth.Grant{}, commitThen(ctx, tx, mcpauth.ErrInvalidGrant)
	}
	if err := insertTokens(ctx, queries, grant.ID, tokens, now); err != nil {
		return mcpauth.Grant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return mcpauth.Grant{}, fmt.Errorf("commit mcp oauth refresh: %w", err)
	}
	return grant.Grant, nil
}

type loadedGrant struct {
	mcpauth.Grant
	revoked bool
}

func loadGrant(ctx context.Context, queries *sqlc.Queries, id utilities.ID) (loadedGrant, error) {
	row, err := queries.GetMCPOAuthGrant(ctx, uuid(id))
	if err != nil {
		return loadedGrant{}, fmt.Errorf("get mcp oauth grant: %w", err)
	}
	return loadedGrant{
		Grant:   mcpauth.Grant{ID: nullableID(row.ID), TenantID: nullableID(row.TenantID), ClientID: row.ClientID, Scope: firstScope(row.Scopes), Resource: row.Resource},
		revoked: row.RevokedAt.Valid,
	}, nil
}

func insertTokens(ctx context.Context, queries *sqlc.Queries, grantID utilities.ID, tokens []mcpauth.NewToken, now time.Time) error {
	for _, token := range tokens {
		if err := queries.CreateMCPOAuthToken(ctx, sqlc.CreateMCPOAuthTokenParams{
			TokenHash: token.Hash, Kind: string(token.Kind), GrantID: uuid(grantID), Resource: token.Resource, ExpiresAt: pgTime(token.ExpiresAt),
		}); err != nil {
			return fmt.Errorf("create mcp oauth token: %w", err)
		}
	}
	if err := queries.DeleteExpiredMCPOAuthGrantRows(ctx, sqlc.DeleteExpiredMCPOAuthGrantRowsParams{GrantID: uuid(grantID), Cutoff: pgTime(now.Add(-24 * time.Hour))}); err != nil {
		return fmt.Errorf("delete expired mcp oauth rows: %w", err)
	}
	return nil
}

// commitThen keeps the state changes made so far (a consumed code, a revoked
// grant) and reports why the request failed.
func commitThen(ctx context.Context, tx pgx.Tx, result error) error {
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit mcp oauth state before %q: %w", result, err)
	}
	return result
}

func (r MCPOAuthRepository) AuthenticateAccessToken(ctx context.Context, tokenHash string, now time.Time) (mcpauth.AccessTokenRecord, error) {
	queries := sqlc.New(r.pool)
	row, err := queries.AuthenticateMCPOAuthAccessToken(ctx, sqlc.AuthenticateMCPOAuthAccessTokenParams{TokenHash: tokenHash, Now: pgTime(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpauth.AccessTokenRecord{}, mcpauth.ErrInvalidAccessToken
	}
	if err != nil {
		return mcpauth.AccessTokenRecord{}, fmt.Errorf("authenticate mcp oauth access token: %w", err)
	}
	if err := queries.TouchMCPOAuthGrant(ctx, sqlc.TouchMCPOAuthGrantParams{ID: row.GrantID, Now: pgTime(now)}); err != nil {
		slog.WarnContext(ctx, "MCP OAuth last-use update failed", "event", "mcp.oauth.touch_failed", "error", err)
	}
	return mcpauth.AccessTokenRecord{GrantID: nullableID(row.GrantID), TenantID: nullableID(row.TenantID), Scope: firstScope(row.Scopes), GrantResource: row.GrantResource, TokenResource: row.TokenResource}, nil
}

func (r MCPOAuthRepository) RevokeByToken(ctx context.Context, tokenHash, clientID string, now time.Time) error {
	queries := sqlc.New(r.pool)
	found, err := queries.FindMCPOAuthGrantByToken(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && found.ClientID != clientID {
		return nil
	}
	if err != nil {
		return fmt.Errorf("find mcp oauth grant by token: %w", err)
	}
	if _, err := queries.RevokeMCPOAuthGrant(ctx, sqlc.RevokeMCPOAuthGrantParams{ID: found.GrantID, Now: pgTime(now)}); err != nil {
		return fmt.Errorf("revoke mcp oauth grant: %w", err)
	}
	return nil
}

func (r MCPOAuthRepository) ListGrants(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (mcpauth.GrantList, error) {
	params := sqlc.ListTenantMCPOAuthGrantsParams{TenantID: uuid(tenantID), PageSize: int32(page.Size() + 1)}
	if cursor := page.Cursor(); cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = pgTime(cursor.CreatedAt)
		params.CursorID = uuid(cursor.ID)
	}
	rows, err := sqlc.New(r.pool).ListTenantMCPOAuthGrants(ctx, params)
	if err != nil {
		return mcpauth.GrantList{}, fmt.Errorf("list mcp oauth grants: %w", err)
	}
	hasMore := len(rows) > page.Size()
	if hasMore {
		rows = rows[:page.Size()]
	}
	list := mcpauth.GrantList{Grants: make([]mcpauth.Grant, 0, len(rows)), Page: pagination.Page{PageSize: page.Size(), HasMore: hasMore}}
	for _, row := range rows {
		grant := mcpauth.Grant{ID: nullableID(row.ID), TenantID: tenantID, ClientID: row.ClientID, ClientName: row.ClientName, Scope: firstScope(row.Scopes), Resource: row.Resource, CreatedAt: row.CreatedAt.Time}
		if row.LastUsedAt.Valid {
			used := row.LastUsedAt.Time
			grant.LastUsedAt = &used
		}
		list.Grants = append(list.Grants, grant)
	}
	if hasMore {
		last := list.Grants[len(list.Grants)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return list, nil
}

func (r MCPOAuthRepository) RevokeTenantGrant(ctx context.Context, tenantID, grantID utilities.ID, now time.Time) error {
	count, err := sqlc.New(r.pool).RevokeTenantMCPOAuthGrant(ctx, sqlc.RevokeTenantMCPOAuthGrantParams{ID: uuid(grantID), TenantID: uuid(tenantID), Now: pgTime(now)})
	if err != nil {
		return fmt.Errorf("revoke tenant mcp oauth grant: %w", err)
	}
	if count == 0 {
		return mcpauth.ErrGrantNotFound
	}
	return nil
}

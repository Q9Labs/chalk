// Package mcpauth is the OAuth 2.1 authorization server for the hosted MCP
// endpoint. It issues opaque, hashed-at-rest tokens bound to one tenant, one
// client and one resource. HTTP and storage live at the edges.
package mcpauth

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	ScopeRead   = "chalk:read"
	ScopeManage = "chalk:manage"
)

// Config holds deployment-owned values. A zero Issuer means OAuth is disabled.
type Config struct {
	// Issuer is the public API origin, such as https://api.chalkmeet.com.
	Issuer string
	// ConsentURL is the dashboard page that shows the consent screen.
	ConsentURL string
	// ExtraRedirectURIs are exact https redirect URIs allowed in addition to the built-in clients.
	ExtraRedirectURIs []string

	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	CodeTTL         time.Duration
	RequestTTL      time.Duration
	Now             func() time.Time
}

// Resource is the canonical MCP resource every token is bound to.
func (c Config) Resource() string { return c.Issuer + "/mcp" }

func (c Config) withDefaults() Config {
	if c.AccessTokenTTL == 0 {
		c.AccessTokenTTL = time.Hour
	}
	if c.RefreshTokenTTL == 0 {
		c.RefreshTokenTTL = 30 * 24 * time.Hour
	}
	if c.CodeTTL == 0 {
		c.CodeTTL = time.Minute
	}
	if c.RequestTTL == 0 {
		c.RequestTTL = 10 * time.Minute
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

type Client struct {
	ID           utilities.ID
	ClientID     string
	Name         string
	RedirectURIs []string
}

// AuthorizationRequest is a validated /authorize request that waits for consent.
type AuthorizationRequest struct {
	ClientID      string
	ClientName    string
	RedirectURI   string
	State         string
	CodeChallenge string
	Scope         string
	Resource      string
	ExpiresAt     time.Time
}

// GrantList is one page of a tenant's active connected apps, newest first.
type GrantList struct {
	Grants []Grant
	Page   pagination.Page
}

// Grant is one connected app: a tenant's consent for one client and resource.
type Grant struct {
	ID         utilities.ID
	TenantID   utilities.ID
	ClientID   string
	ClientName string
	Scope      string
	Resource   string
	LastUsedAt *time.Time
	CreatedAt  time.Time
}

// NewToken is a hashed token ready to store.
type NewToken struct {
	Hash      string
	Kind      TokenKind
	Resource  string
	ExpiresAt time.Time
}

type TokenKind string

const (
	AccessToken  TokenKind = "access"
	RefreshToken TokenKind = "refresh"
)

// Redemption is what a consumed authorization code or refresh token resolves to.
type Redemption struct {
	Grant         Grant
	RedirectURI   string
	CodeChallenge string
}

// AccessGrant is the verified identity behind an access token.
type AccessGrant struct {
	GrantID  utilities.ID
	TenantID utilities.ID
	Scopes   []authentication.Scope
}

type TokenResponse struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int64
	Scope        string
}

// Repository is implemented by the Postgres adapter. Each method is one
// transaction; the implementation owns single-use and reuse-detection atomicity.
type Repository interface {
	CreateClient(ctx context.Context, client Client) error
	GetClient(ctx context.Context, clientID string) (Client, error)
	PruneStale(ctx context.Context, cutoff time.Time) error

	CreateAuthorizationRequest(ctx context.Context, handleHash string, client Client, request AuthorizationRequest) error
	GetOpenAuthorizationRequest(ctx context.Context, handleHash string, now time.Time) (AuthorizationRequest, error)
	ApproveAuthorizationRequest(ctx context.Context, input ApproveRecord) (AuthorizationRequest, error)
	DenyAuthorizationRequest(ctx context.Context, handleHash string, now time.Time) (AuthorizationRequest, error)

	// RedeemCode consumes the code even when verify rejects it, so a wrong
	// verifier burns the code. Presenting a consumed code revokes its grant.
	RedeemCode(ctx context.Context, codeHash string, now time.Time, verify func(Redemption) error, tokens []NewToken) (Grant, error)
	// RotateRefreshToken marks the token used and stores its replacements in one
	// transaction. Presenting a used token, or one issued to another client,
	// revokes its grant.
	RotateRefreshToken(ctx context.Context, tokenHash, clientID string, now time.Time, tokens []NewToken) (Grant, error)

	AuthenticateAccessToken(ctx context.Context, tokenHash string, now time.Time) (AccessTokenRecord, error)
	RevokeByToken(ctx context.Context, tokenHash string, clientID string, now time.Time) error
	ListGrants(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (GrantList, error)
	RevokeTenantGrant(ctx context.Context, tenantID, grantID utilities.ID, now time.Time) error
}

type ApproveRecord struct {
	HandleHash string
	GrantID    utilities.ID
	TenantID   utilities.ID
	Scope      string
	ServiceID  string
	CodeHash   string
	CodeExpiry time.Time
	Now        time.Time
}

type AccessTokenRecord struct {
	GrantID       utilities.ID
	TenantID      utilities.ID
	Scope         string
	GrantResource string
	TokenResource string
}

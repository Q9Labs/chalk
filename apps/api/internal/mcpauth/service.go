package mcpauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	maxClientNameRunes = 100
	maxStateBytes      = 512
	maxRedirectURIs    = 5
)

type Service struct {
	repository Repository
	config     Config
	metadata   MetadataFetcher
}

func NewService(repository Repository, config Config) Service {
	return Service{repository: repository, config: config.withDefaults(), metadata: newHTTPSMetadataFetcher()}
}

func (s Service) Config() Config { return s.config }

// RegisterClient implements RFC 7591 for public clients. Redirect URIs must pass
// the allowlist; nothing else about a client is trusted.
func (s Service) RegisterClient(ctx context.Context, name string, redirectURIs []string) (Client, *Error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxClientNameRunes || !utf8.ValidString(name) {
		return Client{}, oauthError(400, "invalid_client_metadata", "client_name is required and must be at most 100 characters")
	}
	if len(redirectURIs) == 0 || len(redirectURIs) > maxRedirectURIs {
		return Client{}, oauthError(400, "invalid_redirect_uri", "register between 1 and 5 redirect URIs")
	}
	for _, uri := range redirectURIs {
		if !s.config.validRedirectURI(uri) {
			return Client{}, oauthError(400, "invalid_redirect_uri", "redirect URI is not allowed for this server")
		}
	}
	id, err := utilities.NewID()
	if err != nil {
		return Client{}, oauthError(500, "server_error", "could not register client")
	}
	publicID, _, err := newSecret(clientIDPrefix)
	if err != nil {
		return Client{}, oauthError(500, "server_error", "could not register client")
	}
	client := Client{ID: id, ClientID: publicID, Name: name, RedirectURIs: slices.Clone(redirectURIs)}
	if err := s.repository.PruneStale(ctx, s.config.Now().Add(-24*time.Hour)); err != nil {
		slog.ErrorContext(ctx, "MCP OAuth stale registration cleanup failed", "event", "mcp.oauth.prune_failed", "error", err)
	}
	if err := s.repository.CreateClient(ctx, client); err != nil {
		slog.ErrorContext(ctx, "MCP OAuth client registration failed", "event", "mcp.oauth.register_failed", "error", err)
		return Client{}, oauthError(500, "server_error", "could not register client")
	}
	slog.InfoContext(ctx, "MCP OAuth client registered", "event", "mcp.oauth.client_registered", "client_id", client.ClientID)
	return client, nil
}

type AuthorizeParams struct {
	ResponseType        string
	ClientID            string
	RedirectURI         string
	State               string
	CodeChallenge       string
	CodeChallengeMethod string
	Scope               string
	Resources           []string
}

// Authorize validates an /authorize request and stores it until a signed-in
// person decides. It returns the dashboard consent URL.
func (s Service) Authorize(ctx context.Context, params AuthorizeParams) (string, *AuthorizeFailure) {
	var client Client
	if IsMetadataClientID(params.ClientID) {
		var failure *Error
		if client, failure = s.metadataClient(ctx, params.ClientID); failure != nil {
			return "", &AuthorizeFailure{Err: failure}
		}
	} else {
		var err error
		client, err = s.repository.GetClient(ctx, params.ClientID)
		if errors.Is(err, ErrClientNotFound) {
			return "", &AuthorizeFailure{Err: oauthError(400, "invalid_request", "unknown client_id")}
		}
		if err != nil {
			slog.ErrorContext(ctx, "MCP OAuth client lookup failed", "event", "mcp.oauth.authorize_failed", "error", err)
			return "", &AuthorizeFailure{Err: oauthError(500, "server_error", "temporary failure")}
		}
	}
	redirectURI := params.RedirectURI
	if redirectURI == "" && len(client.RedirectURIs) == 1 {
		redirectURI = client.RedirectURIs[0]
	}
	// Use the registered string, never the request's, so a redirect can only
	// ever go to a URI that passed the registration allowlist.
	registered := slices.Index(client.RedirectURIs, redirectURI)
	if registered < 0 {
		return "", &AuthorizeFailure{Err: oauthError(400, "invalid_request", "redirect_uri does not match a registered redirect URI")}
	}
	redirectURI = client.RedirectURIs[registered]
	fail := func(code, description string) (string, *AuthorizeFailure) {
		return "", &AuthorizeFailure{Err: oauthError(400, code, description), RedirectURI: redirectURI, State: params.State}
	}
	switch {
	case len(params.State) > maxStateBytes:
		return fail("invalid_request", "state is too long")
	case params.ResponseType != "code":
		return fail("unsupported_response_type", "only response_type=code is supported")
	case params.CodeChallengeMethod != "S256" || !validCodeChallenge(params.CodeChallenge):
		return fail("invalid_request", "PKCE with code_challenge_method=S256 and a valid code_challenge is required")
	}
	for _, resource := range params.Resources {
		if resource != s.config.Resource() {
			return fail("invalid_target", "resource must be "+s.config.Resource())
		}
	}
	handle, handleHash, err := newSecret(handlePrefix)
	if err != nil {
		return fail("server_error", "temporary failure")
	}
	request := AuthorizationRequest{
		ClientID: client.ClientID, ClientName: client.Name, RedirectURI: redirectURI, RedirectURISupplied: params.RedirectURI != "", State: params.State,
		CodeChallenge: params.CodeChallenge, Scope: NormalizeScope(params.Scope), Resource: s.config.Resource(),
		ExpiresAt: s.config.Now().Add(s.config.RequestTTL),
	}
	if err := s.repository.CreateAuthorizationRequest(ctx, handleHash, client, request); err != nil {
		slog.ErrorContext(ctx, "MCP OAuth authorization request failed", "event", "mcp.oauth.authorize_failed", "error", err)
		return fail("server_error", "temporary failure")
	}
	consent, err := url.Parse(s.config.ConsentURL)
	if err != nil {
		return fail("server_error", "temporary failure")
	}
	query := consent.Query()
	query.Set("request", handle)
	consent.RawQuery = query.Encode()
	return consent.String(), nil
}

// ConsentRequest returns what the consent screen shows for a pending request.
func (s Service) ConsentRequest(ctx context.Context, handle string) (AuthorizationRequest, error) {
	hash, ok := hashHandle(handle)
	if !ok {
		return AuthorizationRequest{}, ErrRequestNotFound
	}
	return s.repository.GetOpenAuthorizationRequest(ctx, hash, s.config.Now())
}

// Approve records consent for one tenant and returns the client redirect.
// serviceID names the authenticated dashboard service that vouched for the person.
func (s Service) Approve(ctx context.Context, handle string, tenantID utilities.ID, scope, serviceID string) (string, error) {
	hash, ok := hashHandle(handle)
	if !ok {
		return "", ErrRequestNotFound
	}
	pending, err := s.repository.GetOpenAuthorizationRequest(ctx, hash, s.config.Now())
	if err != nil {
		return "", err
	}
	if !ApprovalAllowed(pending.Scope, scope) {
		return "", ErrInvalidApproval
	}
	grantID, err := utilities.NewID()
	if err != nil {
		return "", fmt.Errorf("new grant id: %w", err)
	}
	code, codeHash, err := newSecret(codePrefix)
	if err != nil {
		return "", err
	}
	now := s.config.Now()
	request, err := s.repository.ApproveAuthorizationRequest(ctx, ApproveRecord{
		HandleHash: hash, GrantID: grantID, TenantID: tenantID, Scope: scope, ServiceID: serviceID,
		CodeHash: codeHash, CodeExpiry: now.Add(s.config.CodeTTL), Now: now,
	})
	if err != nil {
		return "", err
	}
	slog.InfoContext(ctx, "MCP OAuth grant created", "event", "mcp.oauth.grant_created", "grant_id", grantID.String(), "tenant_id", tenantID.String(), "client_id", pending.ClientID, "scope", scope)
	return s.redirect(request.RedirectURI, map[string]string{"code": code, "state": request.State}), nil
}

// Deny rejects a pending request and returns the client redirect with access_denied.
func (s Service) Deny(ctx context.Context, handle string) (string, error) {
	hash, ok := hashHandle(handle)
	if !ok {
		return "", ErrRequestNotFound
	}
	request, err := s.repository.DenyAuthorizationRequest(ctx, hash, s.config.Now())
	if err != nil {
		return "", err
	}
	return s.redirect(request.RedirectURI, map[string]string{"error": "access_denied", "state": request.State}), nil
}

func (s Service) redirect(base string, values map[string]string) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	query := u.Query()
	for key, value := range values {
		if value != "" {
			query.Set(key, value)
		}
	}
	query.Set("iss", s.config.Issuer)
	u.RawQuery = query.Encode()
	return u.String()
}

// RedirectError builds the redirect for a rejected request whose client was validated.
func (s Service) RedirectError(failure *AuthorizeFailure) string {
	return s.redirect(failure.RedirectURI, map[string]string{"error": failure.Err.Code, "error_description": failure.Err.Description, "state": failure.State})
}

type TokenParams struct {
	GrantType    string
	ClientID     string
	Code         string
	RedirectURI  string
	CodeVerifier string
	RefreshToken string
	Resources    []string
}

func (s Service) Token(ctx context.Context, params TokenParams) (TokenResponse, *Error) {
	if _, err := s.repository.GetClient(ctx, params.ClientID); errors.Is(err, ErrClientNotFound) {
		return TokenResponse{}, oauthError(401, "invalid_client", "unknown client")
	} else if err != nil {
		return TokenResponse{}, oauthError(500, "server_error", "temporary failure")
	}
	for _, resource := range params.Resources {
		if resource != s.config.Resource() {
			return TokenResponse{}, oauthError(400, "invalid_target", "resource must be "+s.config.Resource())
		}
	}
	switch params.GrantType {
	case "authorization_code":
		return s.exchangeCode(ctx, params)
	case "refresh_token":
		return s.refresh(ctx, params)
	default:
		return TokenResponse{}, oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token")
	}
}

func (s Service) exchangeCode(ctx context.Context, params TokenParams) (TokenResponse, *Error) {
	if !strings.HasPrefix(params.Code, codePrefix) || len(params.Code) > 128 {
		return TokenResponse{}, oauthError(400, "invalid_grant", "authorization code is invalid")
	}
	response, tokens, err := s.mint(s.config.Resource())
	if err != nil {
		return TokenResponse{}, oauthError(500, "server_error", "temporary failure")
	}
	verify := func(redemption Redemption) error {
		if redemption.Grant.ClientID != params.ClientID || !redirectMatches(redemption, params.RedirectURI) || !verifyPKCE(params.CodeVerifier, redemption.CodeChallenge) {
			return ErrInvalidGrant
		}
		return nil
	}
	grant, err := s.repository.RedeemCode(ctx, hashSecret(params.Code), s.config.Now(), verify, tokens)
	if err != nil {
		return TokenResponse{}, s.grantError(ctx, err)
	}
	response.Scope = grant.Scope
	return response, nil
}

// redirectMatches applies RFC 6749 section 4.1.3: a redirect_uri that the
// authorization request carried must come back identical, and one it omitted
// may be omitted again or name the single registered URI.
func redirectMatches(redemption Redemption, redirectURI string) bool {
	if redirectURI == redemption.RedirectURI {
		return true
	}
	return !redemption.RedirectURISupplied && redirectURI == ""
}

func (s Service) refresh(ctx context.Context, params TokenParams) (TokenResponse, *Error) {
	if !strings.HasPrefix(params.RefreshToken, refreshTokenPrefix) || len(params.RefreshToken) > 128 {
		return TokenResponse{}, oauthError(400, "invalid_grant", "refresh token is invalid")
	}
	response, tokens, err := s.mint(s.config.Resource())
	if err != nil {
		return TokenResponse{}, oauthError(500, "server_error", "temporary failure")
	}
	grant, err := s.repository.RotateRefreshToken(ctx, hashSecret(params.RefreshToken), params.ClientID, s.config.Now(), tokens)
	if err != nil {
		return TokenResponse{}, s.grantError(ctx, err)
	}
	response.Scope = grant.Scope
	return response, nil
}

func (s Service) grantError(ctx context.Context, err error) *Error {
	switch {
	case errors.Is(err, ErrGrantReused):
		slog.WarnContext(ctx, "MCP OAuth credential reuse detected; grant revoked", "event", "mcp.oauth.reuse_detected")
		return oauthError(400, "invalid_grant", "credential was already used; the connection was revoked")
	case errors.Is(err, ErrInvalidGrant):
		return oauthError(400, "invalid_grant", "credential is invalid or expired")
	default:
		slog.ErrorContext(ctx, "MCP OAuth token exchange failed", "event", "mcp.oauth.token_failed", "error", err)
		return oauthError(500, "server_error", "temporary failure")
	}
}

func (s Service) mint(resource string) (TokenResponse, []NewToken, error) {
	access, accessHash, err := newSecret(AccessTokenPrefix)
	if err != nil {
		return TokenResponse{}, nil, err
	}
	refresh, refreshHash, err := newSecret(refreshTokenPrefix)
	if err != nil {
		return TokenResponse{}, nil, err
	}
	now := s.config.Now()
	return TokenResponse{AccessToken: access, RefreshToken: refresh, ExpiresIn: int64(s.config.AccessTokenTTL.Seconds())}, []NewToken{
		{Hash: accessHash, Kind: AccessToken, Resource: resource, ExpiresAt: now.Add(s.config.AccessTokenTTL)},
		{Hash: refreshHash, Kind: RefreshToken, Resource: resource, ExpiresAt: now.Add(s.config.RefreshTokenTTL)},
	}, nil
}

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

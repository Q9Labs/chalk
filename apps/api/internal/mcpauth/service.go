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

// authorizeClient finds the client an /authorize request names: a metadata
// document for a URL client_id, a stored row otherwise.
func (s Service) authorizeClient(ctx context.Context, clientID string) (Client, *AuthorizeFailure) {
	if IsMetadataClientID(clientID) {
		client, failure := s.metadataClient(ctx, clientID)
		if failure != nil {
			return Client{}, &AuthorizeFailure{Err: failure}
		}
		return client, nil
	}
	client, err := s.repository.GetClient(ctx, clientID)
	if errors.Is(err, ErrClientNotFound) {
		return Client{}, &AuthorizeFailure{Err: oauthError(400, "invalid_request", "unknown client_id")}
	}
	if err != nil {
		slog.ErrorContext(ctx, "MCP OAuth client lookup failed", "event", "mcp.oauth.authorize_failed", "error", err)
		return Client{}, &AuthorizeFailure{Err: oauthError(500, "server_error", "temporary failure")}
	}
	return client, nil
}

// authorizeParamsProblem returns the OAuth error code and description for the
// first rule the request breaks, or an empty code.
func (s Service) authorizeParamsProblem(params AuthorizeParams) (code, description string) {
	switch {
	case len(params.State) > maxStateBytes:
		return "invalid_request", "state is too long"
	case params.ResponseType != "code":
		return "unsupported_response_type", "only response_type=code is supported"
	case params.CodeChallengeMethod != "S256" || !validCodeChallenge(params.CodeChallenge):
		return "invalid_request", "PKCE with code_challenge_method=S256 and a valid code_challenge is required"
	case slices.ContainsFunc(params.Resources, func(resource string) bool { return resource != s.config.Resource() }):
		return "invalid_target", "resource must be " + s.config.Resource()
	}
	return "", ""
}

// Authorize validates an /authorize request and stores it until a signed-in
// person decides. It returns the dashboard consent URL.
func (s Service) Authorize(ctx context.Context, params AuthorizeParams) (string, *AuthorizeFailure) {
	client, failure := s.authorizeClient(ctx, params.ClientID)
	if failure != nil {
		return "", failure
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
	if code, description := s.authorizeParamsProblem(params); code != "" {
		return fail(code, description)
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

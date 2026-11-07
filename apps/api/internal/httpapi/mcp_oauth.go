package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"html"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const maxOAuthBodyBytes = 8 << 10

var (
	mcpOAuthRegisterRateLimit = ratelimit.Policy{Name: ratelimit.PolicyNameMCPOAuthRegister, Limit: 10, Window: time.Hour}
	mcpOAuthProtocolRateLimit = ratelimit.Policy{Name: ratelimit.PolicyNameMCPOAuthProtocol, Limit: 60, Window: time.Minute}
)

// MCPOAuthService is the authorization server behind /oauth and /.well-known.
type MCPOAuthService interface {
	Config() mcpauth.Config
	RegisterClient(ctx context.Context, name string, redirectURIs []string) (mcpauth.Client, *mcpauth.Error)
	Authorize(ctx context.Context, params mcpauth.AuthorizeParams) (string, *mcpauth.AuthorizeFailure)
	RedirectError(failure *mcpauth.AuthorizeFailure) string
	Token(ctx context.Context, params mcpauth.TokenParams) (mcpauth.TokenResponse, *mcpauth.Error)
	Revoke(ctx context.Context, rawToken, clientID string) error
	Authenticate(ctx context.Context, rawToken string) (authentication.Principal, error)
	ConsentRequest(ctx context.Context, handle string) (mcpauth.AuthorizationRequest, error)
	Approve(ctx context.Context, handle string, tenantID utilities.ID, scope, serviceID string) (string, error)
	Deny(ctx context.Context, handle string) (string, error)
	ListGrants(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (mcpauth.GrantList, error)
	RevokeGrant(ctx context.Context, tenantID, grantID utilities.ID) error
}

// mountMCPOAuthProtocolRoutes serves the unversioned OAuth protocol routes. They
// follow RFC 6749, 7009, 7591, 8414 and 9728 wire formats, not the /v1 envelope.
func mountMCPOAuthProtocolRoutes(r chi.Router, service MCPOAuthService, limits RateLimitOptions) {
	if service == nil {
		return
	}
	config := service.Config()
	protocol := rateLimit(limits, mcpOAuthProtocolRateLimit)
	metadata := func(document any) http.Handler {
		return protocol(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Cache-Control", "public, max-age=300")
			writeOAuthJSON(w, http.StatusOK, document, false)
		}))
	}
	resource := map[string]any{
		"resource":                 config.Resource(),
		"authorization_servers":    []string{config.Issuer},
		"scopes_supported":         mcpauth.SupportedScopes(),
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "Chalk",
	}
	r.Method(http.MethodGet, "/.well-known/oauth-protected-resource", metadata(resource))
	r.Method(http.MethodGet, "/.well-known/oauth-protected-resource/mcp", metadata(resource))
	r.Method(http.MethodGet, "/.well-known/oauth-authorization-server", metadata(map[string]any{
		"issuer":                                         config.Issuer,
		"authorization_endpoint":                         config.Issuer + "/oauth/authorize",
		"token_endpoint":                                 config.Issuer + "/oauth/token",
		"registration_endpoint":                          config.Issuer + "/oauth/register",
		"revocation_endpoint":                            config.Issuer + "/oauth/revoke",
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"scopes_supported":                               mcpauth.SupportedScopes(),
		"authorization_response_iss_parameter_supported": true,
	}))
	r.Method(http.MethodPost, "/oauth/register", rateLimit(limits, mcpOAuthRegisterRateLimit)(registerHandler(service)))
	r.Method(http.MethodGet, "/oauth/authorize", protocol(authorizeHandler(service)))
	r.Method(http.MethodPost, "/oauth/token", protocol(tokenHandler(service)))
	r.Method(http.MethodPost, "/oauth/revoke", protocol(revokeHandler(service)))
}

func registerHandler(service MCPOAuthService) http.HandlerFunc {
	type registration struct {
		ClientName              string   `json:"client_name"`
		RedirectURIs            []string `json:"redirect_uris"`
		TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var body registration
		// RFC 7591 clients send many optional fields; ignore the ones we do not use.
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOAuthBodyBytes)).Decode(&body); err != nil {
			writeOAuthError(w, &mcpauth.Error{Status: http.StatusBadRequest, Code: "invalid_client_metadata", Description: "send a JSON client registration"})
			return
		}
		if body.TokenEndpointAuthMethod != "" && body.TokenEndpointAuthMethod != "none" {
			writeOAuthError(w, &mcpauth.Error{Status: http.StatusBadRequest, Code: "invalid_client_metadata", Description: "only public clients (token_endpoint_auth_method=none) are supported"})
			return
		}
		client, oauthErr := service.RegisterClient(r.Context(), body.ClientName, body.RedirectURIs)
		if oauthErr != nil {
			writeOAuthError(w, oauthErr)
			return
		}
		writeOAuthJSON(w, http.StatusCreated, map[string]any{
			"client_id":                  client.ClientID,
			"client_name":                client.Name,
			"redirect_uris":              client.RedirectURIs,
			"token_endpoint_auth_method": "none",
			"grant_types":                []string{"authorization_code", "refresh_token"},
			"response_types":             []string{"code"},
		}, true)
	}
}

func authorizeHandler(service MCPOAuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		consentURL, failure := service.Authorize(r.Context(), mcpauth.AuthorizeParams{
			ResponseType: query.Get("response_type"), ClientID: query.Get("client_id"), RedirectURI: query.Get("redirect_uri"),
			State: query.Get("state"), CodeChallenge: query.Get("code_challenge"), CodeChallengeMethod: query.Get("code_challenge_method"),
			Scope: query.Get("scope"), Resources: query["resource"],
		})
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		switch {
		case failure == nil:
			http.Redirect(w, r, consentURL, http.StatusFound)
		case failure.RedirectURI != "":
			http.Redirect(w, r, service.RedirectError(failure), http.StatusFound)
		default:
			// The client or redirect URI is unverified, so never redirect to it.
			writeAuthorizeErrorPage(w, failure.Err)
		}
	}
}

func writeAuthorizeErrorPage(w http.ResponseWriter, oauthErr *mcpauth.Error) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(oauthErr.Status)
	_, _ = w.Write([]byte("<!doctype html><meta charset=utf-8><title>Chalk</title><body style=\"font:16px system-ui;max-width:32rem;margin:4rem auto\"><h1>This connection request is invalid</h1><p>" + html.EscapeString(oauthErr.Description) + ".</p><p>Return to the app you were connecting and start again.</p>"))
}

func tokenHandler(service MCPOAuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxOAuthBodyBytes)
		if err := r.ParseForm(); err != nil {
			writeOAuthError(w, &mcpauth.Error{Status: http.StatusBadRequest, Code: "invalid_request", Description: "send an application/x-www-form-urlencoded body"})
			return
		}
		form := r.PostForm
		response, oauthErr := service.Token(r.Context(), mcpauth.TokenParams{
			GrantType: form.Get("grant_type"), ClientID: form.Get("client_id"), Code: form.Get("code"), RedirectURI: form.Get("redirect_uri"),
			CodeVerifier: form.Get("code_verifier"), RefreshToken: form.Get("refresh_token"), Resources: form["resource"],
		})
		if oauthErr != nil {
			writeOAuthError(w, oauthErr)
			return
		}
		writeOAuthJSON(w, http.StatusOK, map[string]any{
			"access_token": response.AccessToken, "token_type": "Bearer", "expires_in": response.ExpiresIn,
			"refresh_token": response.RefreshToken, "scope": response.Scope,
		}, true)
	}
}

func revokeHandler(service MCPOAuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxOAuthBodyBytes)
		if err := r.ParseForm(); err != nil {
			writeOAuthError(w, &mcpauth.Error{Status: http.StatusBadRequest, Code: "invalid_request", Description: "send an application/x-www-form-urlencoded body"})
			return
		}
		if err := service.Revoke(r.Context(), r.PostForm.Get("token"), r.PostForm.Get("client_id")); err != nil {
			writeOAuthError(w, &mcpauth.Error{Status: http.StatusInternalServerError, Code: "server_error", Description: "temporary failure"})
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
	}
}

func writeOAuthJSON(w http.ResponseWriter, status int, document any, noStore bool) {
	if noStore {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(document)
}

func writeOAuthError(w http.ResponseWriter, oauthErr *mcpauth.Error) {
	if oauthErr.Status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_client"`)
	}
	writeOAuthJSON(w, oauthErr.Status, map[string]string{"error": oauthErr.Code, "error_description": oauthErr.Description}, true)
}

// mcpChallenge is the RFC 9728 challenge that tells a client where to start OAuth.
func mcpChallenge(service MCPOAuthService) string {
	if service == nil {
		return ""
	}
	return `Bearer resource_metadata="` + service.Config().Issuer + `/.well-known/oauth-protected-resource/mcp", scope="` + strings.Join(mcpauth.SupportedScopes(), " ") + `"`
}

// mcpStepUpChallenge tells an OAuth client which bundle it must be approved for
// before the refused tool call can succeed (RFC 6750 section 3.1, MCP authorization).
func mcpStepUpChallenge(service MCPOAuthService, bundle string) string {
	return `Bearer error="insufficient_scope", scope="` + bundle + `", resource_metadata="` + service.Config().Issuer + `/.well-known/oauth-protected-resource/mcp"`
}

var errNoOAuthToken = errors.New("no oauth token")

func oauthBearer(r *http.Request) (string, error) {
	credential, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok || !strings.HasPrefix(credential, mcpauth.AccessTokenPrefix) {
		return "", errNoOAuthToken
	}
	return credential, nil
}

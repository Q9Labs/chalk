package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	mcpapi "github.com/q9labs/chalk/features/mcp/api"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type mcpQuotaKey struct{}
type mcpQuota struct {
	key     string
	options RateLimitOptions
}

// NewMCPHandler binds the same typed application handlers used by /v1. No route
// dispatch, HTTP decoding, internal HTTP requests, or raw service bypass occurs.
func NewMCPHandler(options Options) http.Handler {
	server := mcpapi.NewServer()
	bindMCPTenantTools(server, options)
	bindMCPSpaceTools(server, options)
	bindMCPEpisodeTools(server, options)
	bindMCPArtifactTools(server, options)
	bindMCPWebhookTools(server, options)
	transport := mcpapi.NewHandler(server, options.CORS.AllowedOrigins, mcpStepUp(options.OAuth))
	authenticated := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := authentication.PrincipalFromContext(r.Context())
		actor, valid := mcpActor(principal)
		if !ok || !valid {
			writeMCPUnauthenticated(w, options.OAuth)
			return
		}
		scopes := make([]string, 0, len(principal.Scopes))
		for _, s := range principal.Scopes {
			scopes = append(scopes, string(s))
		}
		ctx := mcpapi.WithPrincipal(r.Context(), mcpapi.Principal{ProfileID: principal.TenantID.String(), TenantID: principal.TenantID.String(), ActorID: actor, Scopes: scopes})
		quota := mcpQuota{key: rateLimitKey(r, options.RateLimit.ClientIP), options: options.RateLimit}
		ctx = context.WithValue(ctx, mcpQuotaKey{}, quota)
		ctx = context.WithValue(ctx, writeBudgetContextKey{}, func() error { return quota.allow(ctx, authenticatedWriteRateLimit) })
		if err := quota.allow(ctx, authenticatedReadRateLimit); err != nil {
			apiErr, _ := errorAsAPIError(err)
			writeAPIError(w, apiErr)
			return
		}
		transport.ServeHTTP(w, r.WithContext(ctx))
	})
	return acceptMCPOAuthToken(options.OAuth)(requireTenantAuthentication(options.APIKeyAuthentication, options.RateLimit.ClientIP)(authenticated))
}

// mcpActor names the credential behind a tenant-bound principal for audit
// trails. Only tenant API keys and MCP OAuth grants may call tools.
func mcpActor(principal authentication.Principal) (string, bool) {
	if principal.TenantID.IsZero() {
		return "", false
	}
	switch principal.Kind {
	case authentication.PrincipalAPIKey:
		return "api_key:" + principal.APIKeyID.String(), !principal.APIKeyID.IsZero()
	case authentication.PrincipalOAuth:
		return "oauth:" + principal.GrantID.String(), !principal.GrantID.IsZero()
	default:
		return "", false
	}
}

// acceptMCPOAuthToken turns a valid OAuth access token into a tenant-bound
// principal. A request without any credential, or with a bad OAuth token, gets
// the RFC 9728 challenge so a client can find the authorization server.
func acceptMCPOAuthToken(service MCPOAuthService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if service == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if token, err := oauthBearer(r); err == nil {
				principal, err := service.Authenticate(r.Context(), token)
				switch {
				case err == nil:
					next.ServeHTTP(w, r.WithContext(authentication.ContextWithPrincipal(r.Context(), principal)))
				case errors.Is(err, mcpauth.ErrInvalidAccessToken):
					writeMCPUnauthenticated(w, service)
				default:
					slog.ErrorContext(r.Context(), "MCP OAuth token check failed", "event", "mcp.oauth.authenticate_failed", "error", err)
					writeServiceUnavailable(w)
				}
				return
			}
			if _, present := bearerToken(r.Header.Get("Authorization")); !present {
				if _, ok := authentication.PrincipalFromContext(r.Context()); !ok {
					writeMCPUnauthenticated(w, service)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// mcpStepUp answers a refused tool call from an OAuth connection with a 403 that
// names the bundle to be approved, when a bigger bundle would allow the call.
// API-key connections and calls no bundle can allow get the tool's own refusal:
// there is nothing to step up to, and the tool error names the missing scope.
func mcpStepUp(service MCPOAuthService) mcpapi.ScopeRefusal {
	return func(w http.ResponseWriter, r *http.Request, tool, scope string) bool {
		principal, _ := authentication.PrincipalFromContext(r.Context())
		bundle := mcpauth.SmallestBundleGranting(scope)
		if service == nil || principal.Kind != authentication.PrincipalOAuth || bundle == "" {
			return false
		}
		slog.WarnContext(r.Context(), "MCP tool rejected", "event", "mcp.tool.completed", "tool", tool, "tenant_id", principal.TenantID.String(), "actor_id", "oauth:"+principal.GrantID.String(), "outcome", "auth.insufficient_scope", "needed_scope", bundle)
		w.Header().Set("WWW-Authenticate", mcpStepUpChallenge(service, bundle))
		writeError(w, http.StatusForbidden, apiErrorForbidden.Code, tool+" needs the "+bundle+" scope. Reconnect and approve "+bundle+".")
		return true
	}
}

func writeMCPUnauthenticated(w http.ResponseWriter, service MCPOAuthService) {
	if challenge := mcpChallenge(service); challenge != "" {
		w.Header().Set("WWW-Authenticate", challenge)
	}
	writeUnauthenticated(w)
}
func (q mcpQuota) allow(ctx context.Context, policy ratelimit.Policy) error {
	if q.options.Limiter == nil {
		return nil
	}
	if policy.Name == "" {
		policy = authenticatedReadRateLimit
	}
	if q.options.DisableAuthenticated && (policy.Name == ratelimit.PolicyNameAuthenticatedRead || policy.Name == ratelimit.PolicyNameAuthenticatedWrite) {
		policy.Limit = 0
	}
	now := time.Now()
	if q.options.Now != nil {
		now = q.options.Now()
	}
	decision := q.options.Limiter.Allow(ctx, q.key, policy, now)
	switch decision.State {
	case ratelimit.Allowed:
		return nil
	case ratelimit.Exhausted:
		return apiErrorRateLimited
	default:
		recordRateLimiterUnavailable(ctx, policy.Name)
		return apiErrorServiceUnavailable
	}
}

type mcpRequest struct {
	ctx    context.Context
	tenant utilities.ID
	err    error
}

func newMCPRequest(ctx context.Context) *mcpRequest {
	b := &mcpRequest{ctx: ctx}
	b.tenant = b.id(mcpapi.Connection(ctx).TenantID)
	return b
}
func (b *mcpRequest) id(raw string) utilities.ID {
	id, err := utilities.ParseID(raw)
	if err != nil || id.IsZero() {
		b.err = apiErrorInvalidRequest
	}
	return id
}
func (b *mcpRequest) optionalID(raw string) utilities.ID {
	if raw == "" {
		return utilities.ID{}
	}
	return b.id(raw)
}
func (b *mcpRequest) page(input mcpapi.PageInput) pagination.PageRequest {
	size := input.PageSize
	if size == 0 {
		size = 20
	}
	if size > 50 {
		b.err = apiErrorInvalidPageSize
	}
	var cursor *pagination.Cursor
	if input.Cursor != "" {
		parsed, err := pagination.DecodeCursor(input.Cursor)
		if err != nil {
			b.err = apiErrorInvalidCursor
		} else {
			cursor = &parsed
		}
	}
	result, err := pagination.NewPageRequest(size, cursor)
	if err != nil {
		b.err = paginationAPIError(err)
	}
	return result
}
func (b *mcpRequest) ids(values []string, maxItems int) []utilities.ID {
	if len(values) < 1 || len(values) > maxItems {
		b.err = apiErrorInvalidSpaceIDs
	}
	ids := make([]utilities.ID, 0, len(values))
	seen := map[utilities.ID]bool{}
	for _, raw := range values {
		id := b.id(raw)
		if seen[id] {
			b.err = apiErrorInvalidSpaceIDs
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}
func mcpInvoke[Request, Response any](b *mcpRequest, endpoint Endpoint[Request, Response], request Request) (json.RawMessage, error) {
	if b.err != nil {
		return nil, mcpError(endpoint.apiError(b.err))
	}
	// The transport charged the authenticated read bucket once for this request, and
	// it rejects JSON-RPC batches, so a read tool call needs no second charge.
	policy := endpoint.contract.RateLimit
	if quota, ok := b.ctx.Value(mcpQuotaKey{}).(mcpQuota); ok && policy.Name != "" && policy.Name != ratelimit.PolicyNameAuthenticatedRead {
		if err := quota.allow(b.ctx, endpoint.contract.RateLimit); err != nil {
			return nil, mcpError(endpoint.apiError(err))
		}
	}
	ctx, span := otel.Tracer("chalk/mcp").Start(b.ctx, "mcp."+endpoint.contract.OperationID, trace.WithAttributes(attribute.String("tenant_id", b.tenant.String()), attribute.String("operation", endpoint.contract.OperationID)))
	defer span.End()
	if traced, ok := any(request).(interface{ withTrace(context.Context) Request }); ok {
		request = traced.withTrace(ctx)
	}
	response, err := endpoint.handle(ctx, request)
	outcome := "ok"
	if err != nil {
		outcome = endpoint.apiError(err).Code
	}
	slog.InfoContext(ctx, "MCP application operation completed", "event", "mcp.operation.completed", "operation", endpoint.contract.OperationID, "tenant_id", b.tenant.String(), "actor_id", mcpapi.Connection(ctx).ActorID, "outcome", outcome)
	if err != nil {
		apiErr := endpoint.apiError(err)
		span.SetStatus(codes.Error, apiErr.Code)
		return nil, mcpError(apiErr)
	}
	if len(endpoint.contract.Responses) > 0 && endpoint.contract.Responses[0].Schema == nil {
		return json.RawMessage(`{"completed":true}`), nil
	}
	data, err := json.Marshal(response)
	if err != nil {
		return nil, mcpError(apiErrorInternal)
	}
	return data, nil
}
func mcpError(err APIError) error { return mcpapi.Error{Code: err.Code, Message: err.Message} }
func bindMCPEndpoint[Input, Request, Response any](server *mcp.Server, definition mcpapi.Definition, endpoint Endpoint[Request, Response], request func(*mcpRequest, Input) Request) {
	mcpapi.Bind(server, definition, func(ctx context.Context, input Input) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		return mcpInvoke(b, endpoint, request(b, input))
	})
}

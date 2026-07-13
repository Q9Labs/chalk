package traceharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	CreateTenantScenario             = "tenant-create"
	ExecuteIntegrationActionScenario = "integration-execute-action"
)

// ScenarioResult is the captured output from one execution trace scenario.
type ScenarioResult struct {
	Name       string          `json:"name"`
	StatusCode int             `json:"status_code"`
	Body       json.RawMessage `json:"body"`
	Events     []Event         `json:"events"`
}

// Run executes a named trace scenario.
func Run(ctx context.Context, name string) (ScenarioResult, error) {
	switch name {
	case "", CreateTenantScenario:
		return runCreateTenant(ctx, CreateTenantScenario)
	case RouteAuthRegisterScenario:
		return runRouteAuthRegister(ctx)
	case RouteAuthLoginScenario:
		return runRouteAuthLogin(ctx)
	case RouteAuthLogoutScenario:
		return runRouteAuthLogout(ctx)
	case RouteAuthGoogleStartScenario:
		return runRouteAuthGoogleStart(ctx)
	case RouteAuthGoogleCallbackScenario:
		return runRouteAuthGoogleCallback(ctx)
	case RouteMeScenario:
		return runRouteMe(ctx)
	case RouteTenantCreateScenario:
		return runCreateTenant(ctx, RouteTenantCreateScenario)
	case RouteTenantListSystemScenario:
		return runRouteTenantListSystem(ctx)
	case RouteTenantGetAuthorizedScenario:
		return runRouteTenantGetAuthorized(ctx)
	case RouteTenantUpdateAuthorizedScenario:
		return runRouteTenantUpdateAuthorized(ctx)
	case RouteRegionsListScenario:
		return runRouteRegionsList(ctx)
	case RouteUserCreateScenario:
		return runRouteUserCreate(ctx)
	case RouteUserListSystemScenario:
		return runRouteUserListSystem(ctx)
	case RouteUserGetScenario:
		return runRouteUserGet(ctx)
	case RouteMembershipCreateOwnerScenario:
		return runRouteMembershipCreateOwner(ctx)
	case RouteMembershipListViewerScenario:
		return runRouteMembershipListViewer(ctx)
	case RouteMembershipUpdateOwnerScenario:
		return runRouteMembershipUpdateOwner(ctx)
	case RouteRoomCreateMemberScenario:
		return runRouteRoomCreateMember(ctx)
	case RouteSessionCreateMemberScenario:
		return runRouteSessionCreateMember(ctx)
	case RouteSessionEndMemberScenario:
		return runRouteSessionEndMember(ctx)
	case RouteSessionSyncTokenScenario:
		return runRouteSessionSyncToken(ctx)
	case RouteRecordingTranscribeScenario:
		return runRouteRecordingTranscribe(ctx)
	case RouteJourneyEventIntakeScenario:
		return runRouteJourneyEventIntake(ctx)
	case PolicyTenantSystemAllowScenario:
		return runPolicyTenantSystemAllow(ctx)
	case PolicyTenantAPIKeyScopeScenario:
		return runPolicyTenantAPIKeyScope(ctx)
	case PolicyTenantUserRoleScenario:
		return runPolicyTenantUserRole(ctx)
	case RateLimitIPDenyScenario:
		return runRateLimitIPDeny(ctx)
	case RateLimitPrincipalDenyScenario:
		return runRateLimitPrincipalDeny(ctx)
	case AdapterPostgresTenantCreateScenario:
		return runAdapterPostgresTenantCreate(ctx)
	case AdapterRedisRateLimitScenario:
		return runAdapterRedisRateLimit(ctx)
	case AdapterCloudflareR2SignedURLScenario:
		return runAdapterCloudflareR2SignedURL(ctx)
	case AdapterCloudflareSFUBootstrapScenario:
		return runAdapterCloudflareSFUBootstrap(ctx)
	case AdapterCloudflareRTKJoinScenario:
		return runAdapterCloudflareRTKJoin(ctx)
	case AdapterResendSendEmailScenario:
		return runAdapterResendSendEmail(ctx)
	case EdgeUnauthenticatedRouteScenario:
		return runEdgeUnauthenticatedRoute(ctx)
	case EdgeForbiddenTenantRouteScenario:
		return runEdgeForbiddenTenantRoute(ctx)
	case EdgeInvalidRouteIDScenario:
		return runEdgeInvalidRouteID(ctx)
	case ExecuteIntegrationActionScenario:
		return runExecuteIntegrationAction(ctx)
	case WebhookDeliveryAttemptScenario:
		return runWebhookDeliveryAttempt(ctx)
	default:
		return ScenarioResult{}, fmt.Errorf("unknown trace scenario %q", name)
	}
}

func runCreateTenant(ctx context.Context, name string) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	userID := mustID("11111111-1111-4111-8111-111111111111")
	sessionID := mustID("22222222-2222-4222-8222-222222222222")
	auth := tracedAuthentication{
		recorder:  recorder,
		userID:    userID,
		sessionID: sessionID,
		now:       now,
	}
	repository := tracedTenantRepository{
		recorder: recorder,
		now:      now,
	}
	service := tracedTenantService{
		recorder: recorder,
		next:     tenants.NewService(repository),
	}

	handler := httpapi.NewRouter(httpapi.Options{
		RateLimit:      noRateLimits(now),
		Authentication: auth,
		Tenants:        service,
	})
	body := json.RawMessage(`{"name":"  Chalk Demo Workspace  ","default_region":"us","website":" https://chalkmeet.com "}`)
	recorder.Add("scenario", name, "boot router and issue request", map[string]any{
		"request": map[string]any{
			"method": "POST",
			"path":   "/v1/tenants",
			"body":   mustDecode(body),
		},
	})

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "/v1/tenants", bytes.NewReader(body))
	if err != nil {
		return ScenarioResult{}, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer trace-session-token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	span := recorder.Start("http", "POST /v1/tenants", "router received request", map[string]any{
		"headers": map[string]string{
			"authorization": "Bearer [redacted]",
			"content-type":  request.Header.Get("Content-Type"),
		},
	})
	handler.ServeHTTP(response, request)
	span.End("router returned response", map[string]any{
		"status": response.Code,
		"body":   mustDecode(response.Body.Bytes()),
	}, nil)

	result := ScenarioResult{
		Name:       name,
		StatusCode: response.Code,
		Body:       resultBody(response.Body.Bytes()),
		Events:     recorder.Events(),
	}
	if response.Code != http.StatusCreated {
		return result, fmt.Errorf("scenario returned HTTP %d", response.Code)
	}

	return result, nil
}

func runExecuteIntegrationAction(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	tenantID := mustID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	userID := mustID("11111111-1111-4111-8111-111111111111")
	sessionID := mustID("22222222-2222-4222-8222-222222222222")
	connectionID := mustID("33333333-3333-4333-8333-333333333333")
	auth := tracedAuthentication{
		recorder:  recorder,
		userID:    userID,
		sessionID: sessionID,
		now:       now,
		scopes: []authentication.Scope{
			authentication.ScopeIntegrationsRead,
			authentication.ScopeIntegrationsWrite,
		},
	}
	catalog, err := integrations.DefaultCatalog()
	if err != nil {
		return ScenarioResult{}, fmt.Errorf("load integration catalog: %w", err)
	}
	repository := tracedIntegrationRepository{
		recorder:     recorder,
		now:          now,
		tenantID:     tenantID,
		userID:       userID,
		connectionID: connectionID,
	}
	provider := tracedIntegrationProvider{recorder: recorder}
	service := integrations.NewService(repository, provider, catalog)
	handler := httpapi.NewRouter(httpapi.Options{
		RateLimit:      noRateLimits(now),
		Authentication: auth,
		TenantAuthz:    tracedTenantAuthorizer{recorder: recorder},
		Integrations:   service,
	})

	body := json.RawMessage(`{"action":"send_message","arguments":{"channel":"C123","text":"Trace recap is ready"}}`)
	path := "/v1/tenants/" + tenantID.String() + "/integrations/connections/" + connectionID.String() + "/actions"
	recorder.Add("scenario", ExecuteIntegrationActionScenario, "boot router and issue action request", map[string]any{
		"request": map[string]any{
			"method": "POST",
			"path":   path,
			"body":   mustDecode(body),
		},
	})

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(body))
	if err != nil {
		return ScenarioResult{}, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer trace-session-token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	span := recorder.Start("http", "POST integration action", "router received request", map[string]any{
		"headers": map[string]string{
			"authorization": "Bearer [redacted]",
			"content-type":  request.Header.Get("Content-Type"),
		},
	})
	handler.ServeHTTP(response, request)
	span.End("router returned response", map[string]any{
		"status": response.Code,
		"body":   mustDecode(response.Body.Bytes()),
	}, nil)

	result := ScenarioResult{
		Name:       ExecuteIntegrationActionScenario,
		StatusCode: response.Code,
		Body:       resultBody(response.Body.Bytes()),
		Events:     recorder.Events(),
	}
	if response.Code != http.StatusOK {
		return result, fmt.Errorf("scenario returned HTTP %d", response.Code)
	}

	return result, nil
}

type tracedAuthentication struct {
	recorder  *Recorder
	userID    utilities.ID
	sessionID utilities.ID
	now       func() time.Time
	scopes    []authentication.Scope
}

func (a tracedAuthentication) AuthenticateSession(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
	span := a.recorder.Start("auth", "AuthenticateSession", "validate bearer token", map[string]any{
		"token": "[redacted]",
	})
	sessionUser := authentication.SessionUser{
		Session: authentication.Session{
			ID:        a.sessionID,
			UserID:    a.userID,
			TokenHash: "trace-token-hash",
			ExpiresAt: a.now().Add(time.Hour),
			CreatedAt: a.now(),
			UpdatedAt: a.now(),
		},
		User: authentication.User{
			ID:        a.userID,
			Name:      "Trace Reviewer",
			Email:     "trace-reviewer@example.test",
			CreatedAt: a.now(),
			UpdatedAt: a.now(),
		},
	}
	span.End("session accepted", map[string]any{
		"user": map[string]string{
			"id":    sessionUser.User.ID.String(),
			"name":  sessionUser.User.Name,
			"email": sessionUser.User.Email,
		},
		"session_id": sessionUser.Session.ID.String(),
	}, nil)

	return sessionUser, nil
}

func (a tracedAuthentication) PrincipalForSession(session authentication.Session) authentication.Principal {
	principal := authentication.Principal{
		Kind:      authentication.PrincipalUser,
		UserID:    session.UserID,
		SessionID: session.ID,
		Scopes: []authentication.Scope{
			authentication.ScopeTenantsRead,
			authentication.ScopeTenantsWrite,
		},
	}
	if len(a.scopes) > 0 {
		principal.Scopes = a.scopes
	}
	a.recorder.Add("auth", "PrincipalForSession", "attach principal to request context", map[string]any{
		"principal": map[string]any{
			"kind":       principal.Kind,
			"user_id":    principal.UserID.String(),
			"session_id": principal.SessionID.String(),
			"scopes":     principal.Scopes,
		},
	})

	return principal
}

func (tracedAuthentication) Register(context.Context, authentication.RegisterInput) (authentication.AuthResult, error) {
	return authentication.AuthResult{}, errors.New("register is not used by trace scenario")
}

func (tracedAuthentication) Login(context.Context, authentication.LoginInput) (authentication.AuthResult, error) {
	return authentication.AuthResult{}, errors.New("login is not used by trace scenario")
}

func (tracedAuthentication) Logout(context.Context, authentication.Principal) error {
	return errors.New("logout is not used by trace scenario")
}

func (tracedAuthentication) StartGoogleSignIn(context.Context) (authentication.GoogleStart, error) {
	return authentication.GoogleStart{}, errors.New("google start is not used by trace scenario")
}

func (tracedAuthentication) CompleteGoogleSignIn(context.Context, string, string, *string) (authentication.AuthResult, error) {
	return authentication.AuthResult{}, errors.New("google callback is not used by trace scenario")
}

type tracedTenantService struct {
	recorder *Recorder
	next     tenants.Service
}

func (s tracedTenantService) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	span := s.recorder.Start("service", "tenants.Service.CreateTenant", "normalize and validate tenant input", map[string]any{
		"input": tenantCreateInputFields(input),
	})
	tenant, err := s.next.CreateTenant(ctx, input)
	span.End("tenant service returned domain tenant", map[string]any{
		"tenant": tenantFields(tenant),
	}, err)
	return tenant, err
}

type tracedTenantRepository struct {
	recorder *Recorder
	now      func() time.Time
}

func (r tracedTenantRepository) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	span := r.recorder.Start("repository", "TenantRepository.CreateTenant", "begin tenant insert transaction", map[string]any{
		"domain_input": tenantCreateInputFields(input),
	})
	r.recorder.Add("database", "BEGIN", "open transaction", nil)
	r.recorder.Add("database", "INSERT tenants RETURNING *", "execute query", map[string]any{
		"params": map[string]any{
			"id":                  input.ID.String(),
			"name":                input.Name,
			"default_region":      input.DefaultRegion,
			"default_media_plane": input.DefaultMediaPlane,
			"logo_key":            input.LogoKey,
			"website":             input.Website,
		},
	})

	tenant := tenants.Tenant{
		ID:                input.ID,
		Name:              input.Name,
		DefaultRegion:     input.DefaultRegion,
		DefaultMediaPlane: input.DefaultMediaPlane,
		LogoKey:           input.LogoKey,
		Website:           input.Website,
		CreatedAt:         r.now(),
		UpdatedAt:         r.now(),
	}
	r.recorder.Add("database", "row result", "database returned inserted tenant", map[string]any{
		"row": tenantFields(tenant),
	})
	r.recorder.Add("database", "COMMIT", "commit transaction", nil)
	span.End("map database row to domain tenant", map[string]any{
		"tenant": tenantFields(tenant),
	}, nil)
	return tenant, nil
}

type tracedTenantAuthorizer struct {
	recorder *Recorder
}

func (a tracedTenantAuthorizer) AuthorizeTenant(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
	decision := "allow"
	var err error
	if permission.MinimumRole == memberships.RoleAdmin {
		decision = "deny_admin_check"
		err = authorization.ErrForbidden
	}
	a.recorder.Add("authorization", "AuthorizeTenant", "evaluate tenant permission", map[string]any{
		"tenant_id": tenantID.String(),
		"principal": map[string]any{
			"kind":    principal.Kind,
			"user_id": principal.UserID.String(),
			"scopes":  principal.Scopes,
		},
		"required": map[string]any{
			"scope":        permission.Scope,
			"minimum_role": permission.MinimumRole,
		},
		"decision": decision,
	})
	return err
}

type tracedIntegrationRepository struct {
	recorder     *Recorder
	now          func() time.Time
	tenantID     utilities.ID
	userID       utilities.ID
	connectionID utilities.ID
}

func (r tracedIntegrationRepository) CreateConnection(ctx context.Context, input integrations.CreateConnectionInput) (integrations.Connection, error) {
	return integrations.Connection{}, errors.New("create connection is not used by trace scenario")
}

func (r tracedIntegrationRepository) RunInTransaction(ctx context.Context, fn func(integrations.Repository) error) error {
	return fn(r)
}

func (r tracedIntegrationRepository) GetConnection(ctx context.Context, tenantID utilities.ID, id utilities.ID) (integrations.Connection, error) {
	span := r.recorder.Start("repository", "IntegrationRepository.GetConnection", "load local integration connection", map[string]any{
		"tenant_id":     tenantID.String(),
		"connection_id": id.String(),
	})
	connection := r.connection()
	span.End("return active Slack connection", map[string]any{
		"connection": integrationConnectionFields(connection),
	}, nil)
	return connection, nil
}

func (r tracedIntegrationRepository) GetConnectionByExternalRef(ctx context.Context, tenantID utilities.ID, provider integrations.ProviderName, service integrations.ServiceID, externalAccountRef string) (integrations.Connection, error) {
	return integrations.Connection{}, errors.New("get connection by external ref is not used by trace scenario")
}

func (r tracedIntegrationRepository) ListConnections(ctx context.Context, input integrations.ListConnectionsInput) (integrations.ConnectionList, error) {
	return integrations.ConnectionList{}, errors.New("list connections is not used by trace scenario")
}

func (r tracedIntegrationRepository) UpdateConnection(ctx context.Context, input integrations.UpdateConnectionInput) (integrations.Connection, error) {
	return integrations.Connection{}, errors.New("update connection is not used by trace scenario")
}

func (r tracedIntegrationRepository) MarkConnectionUsed(ctx context.Context, tenantID utilities.ID, id utilities.ID) (integrations.Connection, error) {
	span := r.recorder.Start("repository", "IntegrationRepository.MarkConnectionUsed", "update last_used_at after provider success", map[string]any{
		"tenant_id":     tenantID.String(),
		"connection_id": id.String(),
	})
	connection := r.connection()
	now := r.now()
	connection.LastUsedAt = &now
	connection.UpdatedAt = now
	span.End("return updated connection", map[string]any{
		"connection": integrationConnectionFields(connection),
	}, nil)
	return connection, nil
}

func (r tracedIntegrationRepository) CreateAuditLog(ctx context.Context, input integrations.AuditLogInput) error {
	r.recorder.Add("audit", "CreateAuditLog", "record integration action outcome", map[string]any{
		"tenant_id":     input.TenantID.String(),
		"actor_user_id": input.ActorUserID.String(),
		"actor_type":    input.ActorType,
		"action":        input.Action,
		"resource_id":   input.ResourceID.String(),
		"outcome":       input.Outcome,
		"error_code":    input.ErrorCode,
	})
	return nil
}

func (r tracedIntegrationRepository) connection() integrations.Connection {
	return integrations.Connection{
		ID:                 r.connectionID,
		TenantID:           r.tenantID,
		UserID:             r.userID,
		Provider:           integrations.ProviderComposio,
		Service:            "slack",
		ExternalAccountRef: "ca_trace_slack",
		Status:             integrations.StatusActive,
		Scopes:             []string{"chat:write"},
		ConnectedAt:        timePtr(r.now()),
		UpdatedAt:          r.now(),
		CreatedAt:          r.now(),
	}
}

type tracedIntegrationProvider struct {
	recorder *Recorder
}

func (p tracedIntegrationProvider) CreateConnectLink(ctx context.Context, input integrations.CreateConnectLinkInput) (integrations.ConnectLink, error) {
	return integrations.ConnectLink{}, errors.New("create connect link is not used by trace scenario")
}

func (p tracedIntegrationProvider) GetConnection(ctx context.Context, input integrations.GetProviderConnectionInput) (integrations.ProviderConnection, error) {
	return integrations.ProviderConnection{}, errors.New("get provider connection is not used by trace scenario")
}

func (p tracedIntegrationProvider) RefreshConnection(ctx context.Context, input integrations.RefreshConnectionInput) (integrations.ProviderConnection, error) {
	return integrations.ProviderConnection{}, errors.New("refresh connection is not used by trace scenario")
}

func (p tracedIntegrationProvider) DisableConnection(ctx context.Context, input integrations.DisableConnectionInput) error {
	return errors.New("disable connection is not used by trace scenario")
}

func (p tracedIntegrationProvider) ExecuteAction(ctx context.Context, input integrations.ExecuteProviderActionInput) (integrations.ProviderActionResult, error) {
	span := p.recorder.Start("provider", "composio.ExecuteAction", "execute allowlisted Composio tool", map[string]any{
		"user_id":              input.UserID.String(),
		"connected_account_id": input.ExternalAccountRef,
		"toolkit":              input.ToolkitSlug,
		"action_slug":          input.ActionSlug,
		"arguments":            input.Arguments,
	})
	result := integrations.ProviderActionResult{
		Data: map[string]any{
			"ok":      true,
			"channel": input.Arguments["channel"],
		},
		LogID: "log_trace_123",
	}
	span.End("provider returned action result", map[string]any{
		"log_id": result.LogID,
		"data":   result.Data,
	}, nil)
	return result, nil
}

func (r tracedTenantRepository) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	_ = ctx
	span := r.recorder.Start("repository", "TenantRepository.GetTenant", "select tenant by id", map[string]any{
		"tenant_id": id.String(),
	})
	r.recorder.Add("database", "SELECT tenants WHERE id = $1", "execute query", map[string]any{
		"params": map[string]any{"id": id.String()},
	})
	tenant := tenantFixture(r.now)
	span.End("map database row to domain tenant", map[string]any{
		"tenant": tenantFields(tenant),
	}, nil)
	return tenant, nil
}

func (r tracedTenantRepository) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	_ = ctx
	span := r.recorder.Start("repository", "TenantRepository.ListTenants", "select paginated tenants", map[string]any{
		"page": pageRequestFields(page),
	})
	r.recorder.Add("database", "SELECT tenants ORDER BY created_at DESC, id DESC LIMIT $1", "execute query", map[string]any{
		"params": pageRequestFields(page),
	})
	list := tenants.TenantList{
		Tenants: []tenants.Tenant{
			tenantFixture(r.now),
			{
				ID:            mustID("77777777-7777-4777-8777-777777777777"),
				Name:          "Trace Sandbox",
				DefaultRegion: stringPtr("eu"),
				CreatedAt:     r.now(),
				UpdatedAt:     r.now(),
			},
		},
		Page: pagination.Page{PageSize: page.Size(), HasMore: false},
	}
	span.End("map database rows to domain tenant list", map[string]any{
		"list": tenantListFields(list),
	}, nil)
	return list, nil
}

func (r tracedTenantRepository) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	_ = ctx
	span := r.recorder.Start("repository", "TenantRepository.UpdateTenant", "update tenant row", map[string]any{
		"tenant_id":    id.String(),
		"domain_input": tenantUpdateInputFields(input),
	})
	r.recorder.Add("database", "UPDATE tenants SET ... RETURNING *", "execute query", map[string]any{
		"params": map[string]any{
			"id":    id.String(),
			"patch": tenantUpdateInputFields(input),
		},
	})
	tenant := tenantFixture(r.now)
	if input.Name.Set && input.Name.Value != nil {
		tenant.Name = *input.Name.Value
	}
	if input.DefaultRegion.Set {
		tenant.DefaultRegion = input.DefaultRegion.Value
	}
	if input.DefaultMediaPlane.Set {
		tenant.DefaultMediaPlane = input.DefaultMediaPlane.Value
	}
	if input.LogoKey.Set {
		tenant.LogoKey = input.LogoKey.Value
	}
	if input.Website.Set {
		tenant.Website = input.Website.Value
	}
	tenant.UpdatedAt = r.now()
	span.End("map database row to updated domain tenant", map[string]any{
		"tenant": tenantFields(tenant),
	}, nil)
	return tenant, nil
}

type allowAllLimiter struct{}

func (allowAllLimiter) Allow(ctx context.Context, key string, policy ratelimit.Policy, now time.Time) ratelimit.Decision {
	return ratelimit.Decision{
		Allowed:   true,
		Remaining: policy.Limit,
	}
}

func noRateLimits(now func() time.Time) httpapi.RateLimitOptions {
	options := httpapi.DefaultRateLimitOptions()
	options.Limiter = allowAllLimiter{}
	options.Now = now
	return options
}

func tenantCreateInputFields(input tenants.CreateTenantInput) map[string]any {
	return map[string]any{
		"id":                  input.ID.String(),
		"name":                input.Name,
		"default_region":      input.DefaultRegion,
		"default_media_plane": input.DefaultMediaPlane,
		"logo_key":            input.LogoKey,
		"website":             input.Website,
	}
}

func tenantFields(tenant tenants.Tenant) map[string]any {
	return map[string]any{
		"id":                  tenant.ID.String(),
		"name":                tenant.Name,
		"default_region":      tenant.DefaultRegion,
		"default_media_plane": tenant.DefaultMediaPlane,
		"logo_key":            tenant.LogoKey,
		"website":             tenant.Website,
		"created_at":          tenant.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updated_at":          tenant.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func integrationConnectionFields(connection integrations.Connection) map[string]any {
	return map[string]any{
		"id":                   connection.ID.String(),
		"tenant_id":            connection.TenantID.String(),
		"user_id":              connection.UserID.String(),
		"provider":             connection.Provider,
		"service":              connection.Service,
		"external_account_ref": connection.ExternalAccountRef,
		"status":               connection.Status,
		"scopes":               connection.Scopes,
		"last_used_at":         optionalTraceTime(connection.LastUsedAt),
	}
}

func optionalTraceTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func timePtr(value time.Time) *time.Time {
	return &value
}

func deterministicClock() func() time.Time {
	start := time.Date(2026, time.July, 6, 1, 0, 0, 0, time.UTC)
	var tick int64
	return func() time.Time {
		tick++
		return start.Add(time.Duration(tick) * time.Millisecond)
	}
}

func mustID(value string) utilities.ID {
	id, err := utilities.ParseID(value)
	if err != nil {
		panic(err)
	}
	return id
}

func mustDecode(data []byte) any {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return string(data)
	}
	return value
}

// resultBody keeps a JSON response verbatim and wraps any other payload
// (redirect HTML, plain text, empty bodies) as a JSON string so a
// ScenarioResult always marshals in -format json.
func resultBody(data []byte) json.RawMessage {
	if json.Valid(data) {
		return json.RawMessage(data)
	}
	quoted, _ := json.Marshal(string(data))
	return json.RawMessage(quoted)
}

var _ httpapi.AuthenticationService = tracedAuthentication{}
var _ httpapi.TenantService = tracedTenantService{}
var _ tenants.TenantRepository = tracedTenantRepository{}

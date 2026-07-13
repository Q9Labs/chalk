package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

const (
	webhookTenantID   = "11111111-1111-1111-1111-111111111111"
	webhookEndpointID = "22222222-2222-2222-2222-222222222222"
	webhookDeliveryID = "33333333-3333-3333-3333-333333333333"
)

type webhookService struct {
	create         func(context.Context, webhooks.CreateInput) (webhooks.CreateResult, error)
	get            func(context.Context, utilities.ID, utilities.ID) (webhooks.Endpoint, error)
	list           func(context.Context, utilities.ID, pagination.PageRequest) (webhooks.EndpointList, error)
	patch          func(context.Context, utilities.ID, utilities.ID, webhooks.PatchInput) (webhooks.Endpoint, error)
	rotate         func(context.Context, utilities.ID, utilities.ID, bool, string) (webhooks.RotateResult, error)
	listDeliveries func(context.Context, utilities.ID, utilities.ID, webhooks.DeliveryFilters, pagination.PageRequest) (webhooks.DeliveryList, error)
	getDelivery    func(context.Context, utilities.ID, utilities.ID, utilities.ID) (webhooks.DeliveryDetail, error)
	redeliver      func(context.Context, utilities.ID, utilities.ID, utilities.ID, string) (webhooks.DeliveryResult, error)
}

func (s webhookService) Create(ctx context.Context, input webhooks.CreateInput) (webhooks.CreateResult, error) {
	if s.create == nil {
		return webhooks.CreateResult{}, errors.New("unexpected Create call")
	}
	return s.create(ctx, input)
}
func (s webhookService) Get(ctx context.Context, tenantID, endpointID utilities.ID) (webhooks.Endpoint, error) {
	if s.get == nil {
		return webhooks.Endpoint{}, errors.New("unexpected Get call")
	}
	return s.get(ctx, tenantID, endpointID)
}
func (s webhookService) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (webhooks.EndpointList, error) {
	if s.list == nil {
		return webhooks.EndpointList{}, errors.New("unexpected List call")
	}
	return s.list(ctx, tenantID, page)
}
func (s webhookService) Patch(ctx context.Context, tenantID, endpointID utilities.ID, input webhooks.PatchInput) (webhooks.Endpoint, error) {
	if s.patch == nil {
		return webhooks.Endpoint{}, errors.New("unexpected Patch call")
	}
	return s.patch(ctx, tenantID, endpointID, input)
}
func (s webhookService) Delete(context.Context, utilities.ID, utilities.ID, int, string) error {
	return errors.New("unexpected Delete call")
}
func (s webhookService) RotateSecret(ctx context.Context, tenantID, endpointID utilities.ID, immediate bool, key string) (webhooks.RotateResult, error) {
	if s.rotate == nil {
		return webhooks.RotateResult{}, errors.New("unexpected RotateSecret call")
	}
	return s.rotate(ctx, tenantID, endpointID, immediate, key)
}
func (s webhookService) Test(context.Context, utilities.ID, utilities.ID, string, webhooks.EventMetadata) (webhooks.DeliveryResult, error) {
	return webhooks.DeliveryResult{}, errors.New("unexpected Test call")
}
func (s webhookService) ListDeliveries(ctx context.Context, tenantID, endpointID utilities.ID, filters webhooks.DeliveryFilters, page pagination.PageRequest) (webhooks.DeliveryList, error) {
	if s.listDeliveries == nil {
		return webhooks.DeliveryList{}, errors.New("unexpected ListDeliveries call")
	}
	return s.listDeliveries(ctx, tenantID, endpointID, filters, page)
}
func (s webhookService) GetDelivery(ctx context.Context, tenantID, endpointID, deliveryID utilities.ID) (webhooks.DeliveryDetail, error) {
	if s.getDelivery == nil {
		return webhooks.DeliveryDetail{}, errors.New("unexpected GetDelivery call")
	}
	return s.getDelivery(ctx, tenantID, endpointID, deliveryID)
}
func (s webhookService) Redeliver(ctx context.Context, tenantID, endpointID, deliveryID utilities.ID, key string) (webhooks.DeliveryResult, error) {
	if s.redeliver == nil {
		return webhooks.DeliveryResult{}, errors.New("unexpected Redeliver call")
	}
	return s.redeliver(ctx, tenantID, endpointID, deliveryID, key)
}
func (webhookService) AuditFailure(context.Context, webhooks.FailureAuditInput) {}

func TestWebhookRoutesRequireAuthenticationAndAdminAuthorization(t *testing.T) {
	routes := []struct{ method, path, body string }{
		{http.MethodPost, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints", `{"name":"events","url":"https://example.com/hook","enabled":true,"api_version":1,"event_types":["room.created"]}`},
		{http.MethodGet, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints", ""},
		{http.MethodGet, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID, ""},
		{http.MethodPatch, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID, `{}`},
		{http.MethodDelete, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID, ""},
		{http.MethodPost, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/rotate-secret", `{"revoke_previous_immediately":false}`},
		{http.MethodPost, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/test", ""},
		{http.MethodGet, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/deliveries", ""},
		{http.MethodGet, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/deliveries/" + webhookDeliveryID, ""},
		{http.MethodPost, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/deliveries/" + webhookDeliveryID + "/redeliver", ""},
	}
	for _, route := range routes {
		t.Run(route.method+" "+route.path+" anonymous", func(t *testing.T) {
			res := requestWithOptionsAndBody(t, route.method, route.path, route.body, httpapi.Options{Webhooks: webhookService{}, Authentication: authenticationService{authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, errors.New("unexpected authentication")
			}}})
			if res.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401: %s", res.Code, res.Body.String())
			}
		})
		for _, forbidden := range []struct {
			name      string
			authorize func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error
		}{
			{name: "cross tenant", authorize: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
				return authorization.ErrForbidden
			}},
			{name: "under role", authorize: func(_ context.Context, _ authentication.Principal, _ utilities.ID, permission authorization.TenantPermission) error {
				if permission.MinimumRole != memberships.RoleAdmin {
					t.Fatalf("minimum role = %q, want admin", permission.MinimumRole)
				}
				return authorization.ErrForbidden
			}},
		} {
			t.Run(route.method+" "+route.path+" "+forbidden.name, func(t *testing.T) {
				req := bearerRequestWithBody(route.method, route.path, "raw-session-token", route.body)
				if route.method == http.MethodPatch || route.method == http.MethodDelete {
					req.Header.Set("If-Match", `"1"`)
				}
				res := requestWithOptionsAndRequest(t, req, authenticatedOptions(t, httpapi.Options{Webhooks: webhookService{}, TenantAuthz: tenantAuthorizer{authorizeTenant: forbidden.authorize}}))
				if res.Code != http.StatusForbidden {
					t.Fatalf("status = %d, want 403: %s", res.Code, res.Body.String())
				}
			})
		}
	}
}

func TestWebhookCreateReturnsOneTimeSecretOnlyOnCreate(t *testing.T) {
	now := time.Date(2026, time.July, 13, 0, 0, 0, 0, time.UTC)
	endpointID, _ := utilities.ParseID(webhookEndpointID)
	tenantID, _ := utilities.ParseID(webhookTenantID)
	endpoint := webhooks.Endpoint{ID: endpointID, TenantID: tenantID, Name: "events", URLRedacted: "https://example.com/***", Enabled: true, Revision: 1, APIVersion: 1, EventTypes: []string{"room.created"}, CreatedAt: now, UpdatedAt: now}
	service := webhookService{create: func(context.Context, webhooks.CreateInput) (webhooks.CreateResult, error) {
		return webhooks.CreateResult{Endpoint: endpoint, Secret: "whsec_once"}, nil
	}, get: func(context.Context, utilities.ID, utilities.ID) (webhooks.Endpoint, error) { return endpoint, nil }}

	create := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/"+webhookTenantID+"/webhook-endpoints", `{"name":"events","url":"https://example.com/hook","enabled":true,"api_version":1,"event_types":["room.created"]}`, httpapi.Options{Webhooks: service})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", create.Code, create.Body.String())
	}
	var created map[string]any
	decodeJSON(t, create, &created)
	if created["secret"] != "whsec_once" {
		t.Fatalf("create secret = %#v", created["secret"])
	}

	get := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/"+webhookTenantID+"/webhook-endpoints/"+webhookEndpointID, httpapi.Options{Webhooks: service})
	var fetched map[string]any
	decodeJSON(t, get, &fetched)
	if _, exists := fetched["secret"]; exists {
		t.Fatal("GET response exposed webhook secret")
	}
}

func TestWebhookCreateAndRotateRejectMissingOrNullRequiredBooleans(t *testing.T) {
	calls := 0
	service := webhookService{
		create: func(context.Context, webhooks.CreateInput) (webhooks.CreateResult, error) {
			calls++
			return webhooks.CreateResult{}, nil
		},
		rotate: func(context.Context, utilities.ID, utilities.ID, bool, string) (webhooks.RotateResult, error) {
			calls++
			return webhooks.RotateResult{}, nil
		},
	}
	tests := []struct {
		name, path, body string
	}{
		{"create missing enabled", "/v1/tenants/" + webhookTenantID + "/webhook-endpoints", `{"name":"events","url":"https://example.com/hook","api_version":1,"event_types":["room.created"]}`},
		{"create null enabled", "/v1/tenants/" + webhookTenantID + "/webhook-endpoints", `{"name":"events","url":"https://example.com/hook","enabled":null,"api_version":1,"event_types":["room.created"]}`},
		{"rotate missing revoke", "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/rotate-secret", `{}`},
		{"rotate null revoke", "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/rotate-secret", `{"revoke_previous_immediately":null}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, test.path, test.body, httpapi.Options{Webhooks: service})
			if res.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", res.Code, res.Body.String())
			}
			assertErrorCode(t, res, "invalid_request")
		})
	}
	if calls != 0 {
		t.Fatalf("service calls = %d, want 0", calls)
	}
}

func TestWebhookRuntimeErrorsAndDeliveryFilters(t *testing.T) {
	service := webhookService{
		patch: func(context.Context, utilities.ID, utilities.ID, webhooks.PatchInput) (webhooks.Endpoint, error) {
			return webhooks.Endpoint{}, webhooks.ErrRevisionConflict
		},
		getDelivery: func(context.Context, utilities.ID, utilities.ID, utilities.ID) (webhooks.DeliveryDetail, error) {
			return webhooks.DeliveryDetail{}, webhooks.ErrEventErased
		},
		redeliver: func(context.Context, utilities.ID, utilities.ID, utilities.ID, string) (webhooks.DeliveryResult, error) {
			return webhooks.DeliveryResult{}, webhooks.ErrDeliveryNotRedeliverable
		},
		listDeliveries: func(_ context.Context, _, _ utilities.ID, filters webhooks.DeliveryFilters, _ pagination.PageRequest) (webhooks.DeliveryList, error) {
			if !slices.Equal(filters.States, []string{"pending", "failed"}) || !slices.Equal(filters.EventTypes, []string{"room.created", "session.ended"}) {
				t.Fatalf("filters = %#v", filters)
			}
			return webhooks.DeliveryList{}, nil
		},
	}
	tests := []struct {
		name, method, path, body, ifMatch string
		status                            int
		code                              string
	}{
		{"revision conflict", http.MethodPatch, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID, `{"enabled":false}`, `"1"`, http.StatusPreconditionFailed, "webhook_endpoint_revision_conflict"},
		{"erased event", http.MethodGet, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/deliveries/" + webhookDeliveryID, "", "", http.StatusGone, "webhook_event_erased"},
		{"redelivery conflict", http.MethodPost, "/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/deliveries/" + webhookDeliveryID + "/redeliver", "", "", http.StatusConflict, "webhook_delivery_not_redeliverable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := bearerRequestWithBody(test.method, test.path, "raw-session-token", test.body)
			if test.ifMatch != "" {
				req.Header.Set("If-Match", test.ifMatch)
			}
			res := requestWithOptionsAndRequest(t, req, authenticatedOptions(t, httpapi.Options{Webhooks: service}))
			if res.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", res.Code, test.status, res.Body.String())
			}
			assertErrorCode(t, res, test.code)
		})
	}
	filters := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/"+webhookTenantID+"/webhook-endpoints/"+webhookEndpointID+"/deliveries?state=pending&state=failed&event_type=room.created&event_type=session.ended", httpapi.Options{Webhooks: service})
	if filters.Code != http.StatusOK {
		t.Fatalf("filter status = %d: %s", filters.Code, filters.Body.String())
	}
}

type webhookRouteLimiter struct {
	seen     map[string]int
	policies []ratelimit.Policy
	keys     []string
}

func (l *webhookRouteLimiter) Allow(_ context.Context, key string, policy ratelimit.Policy, _ time.Time) ratelimit.Decision {
	if l.seen == nil {
		l.seen = make(map[string]int)
	}
	l.policies = append(l.policies, policy)
	l.keys = append(l.keys, key)
	bucket := policy.Name + ":" + key
	l.seen[bucket]++
	if l.seen[bucket] > 1 {
		return ratelimit.Decision{Allowed: false, RetryAfter: 2 * time.Second}
	}
	return ratelimit.Decision{Allowed: true, Remaining: policy.Limit - 1}
}

func TestWebhookReadRoutesUseDedicatedPrincipalScopedRateLimit(t *testing.T) {
	now := time.Date(2026, time.July, 13, 0, 0, 0, 0, time.UTC)
	service := webhookService{
		list: func(context.Context, utilities.ID, pagination.PageRequest) (webhooks.EndpointList, error) {
			return webhooks.EndpointList{}, nil
		},
		get: func(context.Context, utilities.ID, utilities.ID) (webhooks.Endpoint, error) {
			return webhooks.Endpoint{CreatedAt: now, UpdatedAt: now}, nil
		},
		listDeliveries: func(context.Context, utilities.ID, utilities.ID, webhooks.DeliveryFilters, pagination.PageRequest) (webhooks.DeliveryList, error) {
			return webhooks.DeliveryList{}, nil
		},
		getDelivery: func(context.Context, utilities.ID, utilities.ID, utilities.ID) (webhooks.DeliveryDetail, error) {
			return webhooks.DeliveryDetail{Delivery: webhooks.Delivery{CreatedAt: now, UpdatedAt: now}}, nil
		},
	}
	paths := []string{
		"/v1/tenants/" + webhookTenantID + "/webhook-endpoints",
		"/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID,
		"/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/deliveries",
		"/v1/tenants/" + webhookTenantID + "/webhook-endpoints/" + webhookEndpointID + "/deliveries/" + webhookDeliveryID,
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			limiter := &webhookRouteLimiter{}
			res := authenticatedRequestWithOptions(t, http.MethodGet, path, httpapi.Options{Webhooks: service, RateLimit: httpapi.RateLimitOptions{Limiter: limiter}})
			if res.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", res.Code, res.Body.String())
			}
			if got := res.Header().Get(ratelimit.HeaderLimit); got != "300" {
				t.Fatalf("rate limit header = %q, want 300", got)
			}
			if len(limiter.policies) != 1 || limiter.policies[0].Name != ratelimit.PolicyNameWebhookRead {
				t.Fatalf("policies = %#v", limiter.policies)
			}
		})
	}

	limiter := &webhookRouteLimiter{}
	options := authenticatedOptions(t, httpapi.Options{
		Webhooks:  service,
		RateLimit: httpapi.RateLimitOptions{Limiter: limiter},
		Authentication: authenticationService{authenticateSession: func(_ context.Context, token string) (authentication.SessionUser, error) {
			value := authSessionUser(t)
			if token == "second-session-token" {
				id, err := utilities.ParseID("44444444-4444-4444-8444-444444444444")
				if err != nil {
					t.Fatal(err)
				}
				value.User.ID = id
				value.Session.UserID = id
			}
			return value, nil
		}},
	})
	path := paths[0]
	for _, token := range []string{"raw-session-token", "raw-session-token", "second-session-token"} {
		res := requestWithOptionsAndRequest(t, bearerRequest(http.MethodGet, path, token), options)
		want := http.StatusOK
		if token == "raw-session-token" && len(limiter.keys) == 2 {
			want = http.StatusTooManyRequests
			assertErrorCode(t, res, "rate_limited")
			if res.Header().Get(ratelimit.HeaderRetryAfter) != "2" {
				t.Fatalf("retry-after = %q, want 2", res.Header().Get(ratelimit.HeaderRetryAfter))
			}
		}
		if res.Code != want {
			t.Fatalf("token %q status = %d, want %d", token, res.Code, want)
		}
	}
	if len(limiter.keys) != 3 || limiter.keys[0] != limiter.keys[1] || limiter.keys[2] == limiter.keys[0] {
		t.Fatalf("principal keys = %#v", limiter.keys)
	}
}

var _ httpapi.WebhookService = webhookService{}

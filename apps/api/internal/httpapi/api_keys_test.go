package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	apiKeyTestNow       = time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	apiKeyTestTenantID  = apiKeyTestID("11111111-1111-4111-8111-111111111111")
	apiKeyTestOtherID   = apiKeyTestID("22222222-2222-4222-8222-222222222222")
	apiKeyTestKeyID     = apiKeyTestID("33333333-3333-4333-8333-333333333333")
	apiKeyTestUserID    = apiKeyTestID("44444444-4444-4444-8444-444444444444")
	apiKeyTestCallerKey = apiKeyTestID("55555555-5555-4555-8555-555555555555")
)

type apiKeyServiceStub struct {
	create func(context.Context, apikeys.CreateInput) (apikeys.CreateResult, error)
	get    func(context.Context, utilities.ID, utilities.ID) (apikeys.Key, error)
	list   func(context.Context, utilities.ID, pagination.PageRequest) (apikeys.KeyList, error)
	rotate func(context.Context, utilities.ID, utilities.ID, apikeys.RotateInput) (apikeys.RotateResult, error)
	revoke func(context.Context, utilities.ID, utilities.ID) error
}

func (s apiKeyServiceStub) Create(ctx context.Context, input apikeys.CreateInput) (apikeys.CreateResult, error) {
	if s.create == nil {
		return apikeys.CreateResult{}, errors.New("unexpected create")
	}
	return s.create(ctx, input)
}

func (s apiKeyServiceStub) Get(ctx context.Context, tenantID, id utilities.ID) (apikeys.Key, error) {
	if s.get == nil {
		return apikeys.Key{}, errors.New("unexpected get")
	}
	return s.get(ctx, tenantID, id)
}

func (s apiKeyServiceStub) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (apikeys.KeyList, error) {
	if s.list == nil {
		return apikeys.KeyList{}, errors.New("unexpected list")
	}
	return s.list(ctx, tenantID, page)
}

func (s apiKeyServiceStub) Rotate(ctx context.Context, tenantID, id utilities.ID, input apikeys.RotateInput) (apikeys.RotateResult, error) {
	if s.rotate == nil {
		return apikeys.RotateResult{}, errors.New("unexpected rotate")
	}
	return s.rotate(ctx, tenantID, id, input)
}

func (s apiKeyServiceStub) Revoke(ctx context.Context, tenantID, id utilities.ID) error {
	if s.revoke == nil {
		return errors.New("unexpected revoke")
	}
	return s.revoke(ctx, tenantID, id)
}

type apiKeyMembershipReader struct{ role memberships.Role }

func (r apiKeyMembershipReader) GetTenantMembershipForUser(_ context.Context, tenantID, userID utilities.ID) (memberships.Membership, error) {
	return memberships.Membership{TenantID: tenantID, UserID: userID, Role: r.role}, nil
}

type apiKeyAuditWriterStub struct {
	inputs []auditlogs.CreateInput
	err    error
}

func (w *apiKeyAuditWriterStub) Create(_ context.Context, input auditlogs.CreateInput) (auditlogs.AuditLog, error) {
	w.inputs = append(w.inputs, input)
	return auditlogs.AuditLog{}, w.err
}

func TestAPIKeyRouteContractsDeclareProtectedBoundedLifecycle(t *testing.T) {
	contracts := routeContracts(apiKeyEndpoints(nil, nil, nil))
	if len(contracts) != 4 {
		t.Fatalf("contracts = %d, want 4", len(contracts))
	}

	want := map[string]struct {
		method, path string
		status       int
		body, write  bool
	}{
		"createAPIKey": {http.MethodPost, "/v1/tenants/{tenant_id}/api-keys", http.StatusCreated, true, true},
		"listAPIKeys":  {http.MethodGet, "/v1/tenants/{tenant_id}/api-keys", http.StatusOK, false, false},
		"rotateAPIKey": {http.MethodPost, "/v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate", http.StatusOK, true, true},
		"revokeAPIKey": {http.MethodDelete, "/v1/tenants/{tenant_id}/api-keys/{api_key_id}", http.StatusNoContent, false, true},
	}
	for _, contract := range contracts {
		expected, ok := want[contract.OperationID]
		if !ok {
			t.Fatalf("unexpected operation %q", contract.OperationID)
		}
		if contract.Auth != APIAuthSessionOrBearer || contract.Method != expected.method || contract.Path != expected.path {
			t.Fatalf("%s metadata = auth %q, %s %s", contract.OperationID, contract.Auth, contract.Method, contract.Path)
		}
		if len(contract.Responses) != 1 || contract.Responses[0].Status != expected.status {
			t.Fatalf("%s response = %#v", contract.OperationID, contract.Responses)
		}
		if (contract.Request != nil) != expected.body || (contract.BodyLimitBytes > 0) != expected.body {
			t.Fatalf("%s body metadata = request %#v, limit %d", contract.OperationID, contract.Request, contract.BodyLimitBytes)
		}
		if (contract.RateLimit.Name == authenticatedWriteRateLimit.Name) != expected.write {
			t.Fatalf("%s write rate limit = %#v", contract.OperationID, contract.RateLimit)
		}
		if !apiKeyContractHasError(contract, "unauthenticated") || !apiKeyContractHasError(contract, "forbidden") {
			t.Fatalf("%s omits auth errors", contract.OperationID)
		}
	}
}

func TestAPIKeyRoutesRejectAnonymousAndInsufficientCallers(t *testing.T) {
	service := apiKeyServiceStub{create: func(context.Context, apikeys.CreateInput) (apikeys.CreateResult, error) {
		t.Fatal("create should not be called")
		return apikeys.CreateResult{}, nil
	}}
	body := `{"name":"backend","scopes":["rooms:read"],"expires_at":"2026-08-01T00:00:00Z"}`

	anonymous := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(nil), authentication.Principal{}, http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), body)
	assertAPIKeyError(t, anonymous, http.StatusUnauthorized, "unauthenticated")

	member := apiKeyUserPrincipal()
	weakRole := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(apiKeyMembershipReader{role: memberships.RoleMember}), member, http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), body)
	assertAPIKeyError(t, weakRole, http.StatusForbidden, "forbidden")

	wrongScope := apiKeyPrincipal(apiKeyTestTenantID, authentication.ScopeAPIKeysRead)
	insufficient := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(nil), wrongScope, http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), body)
	assertAPIKeyError(t, insufficient, http.StatusForbidden, "forbidden")

	crossTenant := apiKeyPrincipal(apiKeyTestOtherID, authentication.ScopeAPIKeysWrite)
	crossTenantResponse := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(nil), crossTenant, http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), body)
	assertAPIKeyError(t, crossTenantResponse, http.StatusForbidden, "forbidden")
}

func TestAPIKeyCreateAllowsOwnerAndAdminAndReturnsSecretOnce(t *testing.T) {
	for _, role := range []memberships.Role{memberships.RoleOwner, memberships.RoleAdmin} {
		t.Run(string(role), func(t *testing.T) {
			service := apiKeyServiceStub{create: func(_ context.Context, input apikeys.CreateInput) (apikeys.CreateResult, error) {
				if input.TenantID != apiKeyTestTenantID || input.CreatedByUserID != apiKeyTestUserID || input.Name != "backend" {
					t.Fatalf("create input = %+v", input)
				}
				if len(input.Scopes) != 1 || input.Scopes[0] != authentication.ScopeRoomsRead || !input.ExpiresAt.Equal(apiKeyTestNow.Add(time.Hour)) {
					t.Fatalf("create scopes/expiry = %v / %v", input.Scopes, input.ExpiresAt)
				}
				return apikeys.CreateResult{Key: apiKeyFixture(input.Scopes), RawKey: "chalk_sk_new.once"}, nil
			}}
			body := `{"name":"backend","scopes":["rooms:read"],"expires_at":"2026-07-21T13:00:00Z"}`
			response := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(apiKeyMembershipReader{role: role}), apiKeyUserPrincipal(), http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), body)
			if response.Code != http.StatusCreated {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if strings.Count(response.Body.String(), "chalk_sk_new.once") != 1 || strings.Contains(response.Body.String(), "hash") {
				t.Fatalf("create response leaked or duplicated credential data: %s", response.Body.String())
			}
		})
	}
}

func TestAPIKeyCallerCannotGrantOrMutateBroaderScopes(t *testing.T) {
	caller := apiKeyPrincipal(apiKeyTestTenantID, authentication.ScopeAPIKeysWrite, authentication.ScopeAPIKeysDelete, authentication.ScopeRoomsRead)
	authorizer := authorization.NewTenantPolicy(nil)
	createService := apiKeyServiceStub{create: func(context.Context, apikeys.CreateInput) (apikeys.CreateResult, error) {
		t.Fatal("create should not be called")
		return apikeys.CreateResult{}, nil
	}}
	create := serveAPIKeyRequest(t, createService, authorizer, caller, http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), `{"name":"elevated","scopes":["rooms:write"],"expires_at":"2026-08-01T00:00:00Z"}`)
	assertAPIKeyError(t, create, http.StatusForbidden, "forbidden")

	for _, test := range []struct {
		name, method, suffix, body string
	}{
		{"rotate", http.MethodPost, "/rotate", `{}`},
		{"revoke", http.MethodDelete, "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := apiKeyServiceStub{
				get: func(_ context.Context, tenantID, id utilities.ID) (apikeys.Key, error) {
					if tenantID != apiKeyTestTenantID || id != apiKeyTestKeyID {
						t.Fatalf("target lookup = %s / %s", tenantID, id)
					}
					return apiKeyFixture([]authentication.Scope{authentication.ScopeRoomsWrite}), nil
				},
				rotate: func(context.Context, utilities.ID, utilities.ID, apikeys.RotateInput) (apikeys.RotateResult, error) {
					t.Fatal("rotate should not be called")
					return apikeys.RotateResult{}, nil
				},
				revoke: func(context.Context, utilities.ID, utilities.ID) error {
					t.Fatal("revoke should not be called")
					return nil
				},
			}
			path := apiKeyItemPath(apiKeyTestTenantID, apiKeyTestKeyID) + test.suffix
			response := serveAPIKeyRequest(t, service, authorizer, caller, test.method, path, test.body)
			assertAPIKeyError(t, response, http.StatusForbidden, "forbidden")
		})
	}
}

func TestAPIKeyCallerCanCreateKeyWithinOwnScopes(t *testing.T) {
	service := apiKeyServiceStub{create: func(_ context.Context, input apikeys.CreateInput) (apikeys.CreateResult, error) {
		if !input.CreatedByUserID.IsZero() || len(input.Scopes) != 1 || input.Scopes[0] != authentication.ScopeRoomsRead {
			t.Fatalf("create input = %+v", input)
		}
		return apikeys.CreateResult{Key: apiKeyFixture(input.Scopes), RawKey: "chalk_sk_delegated.once"}, nil
	}}
	caller := apiKeyPrincipal(apiKeyTestTenantID, authentication.ScopeAPIKeysWrite, authentication.ScopeRoomsRead)
	response := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(nil), caller, http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), `{"name":"delegated","scopes":["rooms:read"],"expires_at":"2026-08-01T00:00:00Z"}`)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), "chalk_sk_delegated.once") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestAPIKeyAuthorizationFailureAuditIsBoundedAndBestEffort(t *testing.T) {
	audits := &apiKeyAuditWriterStub{err: errors.New("audit unavailable")}
	service := apiKeyServiceStub{create: func(context.Context, apikeys.CreateInput) (apikeys.CreateResult, error) {
		t.Fatal("create should not be called")
		return apikeys.CreateResult{}, nil
	}}
	caller := apiKeyPrincipal(apiKeyTestTenantID, authentication.ScopeAPIKeysWrite, authentication.ScopeRoomsRead)
	body := `{"name":"must-not-appear","scopes":["rooms:write"],"expires_at":"2026-08-01T00:00:00Z"}`
	response := serveAPIKeyRequestWithAudit(t, service, authorization.NewTenantPolicy(nil), audits, caller, http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), body)
	assertAPIKeyError(t, response, http.StatusForbidden, "forbidden")

	if len(audits.inputs) != 1 {
		t.Fatalf("audit inputs = %d, want 1", len(audits.inputs))
	}
	input := audits.inputs[0]
	if input.TenantID != apiKeyTestTenantID || input.ActorType != auditlogs.ActorAPIKey || !input.ActorUserID.IsZero() || input.Action != "api_key.created" || input.Outcome != auditlogs.OutcomeFailure || input.ErrorCode == nil || *input.ErrorCode != "forbidden" {
		t.Fatalf("audit input = %+v", input)
	}
	if input.ResourceType == nil || *input.ResourceType != "api_key" || !input.ResourceID.IsZero() {
		t.Fatalf("audit resource = %v / %s", input.ResourceType, input.ResourceID)
	}
	details := string(input.Details)
	if !strings.Contains(details, apiKeyTestCallerKey.String()) || strings.Contains(details, "must-not-appear") || strings.Contains(details, "rooms:write") || strings.Contains(details, "chalk_sk_") || strings.Contains(details, "prefix") || strings.Contains(details, "hash") {
		t.Fatalf("audit details = %s", details)
	}

	audits.inputs = nil
	userResponse := serveAPIKeyRequestWithAudit(t, service, authorization.NewTenantPolicy(apiKeyMembershipReader{role: memberships.RoleMember}), audits, apiKeyUserPrincipal(), http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), `{"name":"backend","scopes":["rooms:read"],"expires_at":"2026-08-01T00:00:00Z"}`)
	assertAPIKeyError(t, userResponse, http.StatusForbidden, "forbidden")
	if len(audits.inputs) != 1 || audits.inputs[0].ActorType != auditlogs.ActorUser || audits.inputs[0].ActorUserID != apiKeyTestUserID || string(audits.inputs[0].Details) != `{}` {
		t.Fatalf("user audit input = %+v", audits.inputs)
	}
}

func TestAPIKeyListPaginatesWithoutSecrets(t *testing.T) {
	next := pagination.Cursor{CreatedAt: apiKeyTestNow, ID: apiKeyTestKeyID}
	cursor, err := pagination.EncodeCursor(next)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	service := apiKeyServiceStub{list: func(_ context.Context, tenantID utilities.ID, page pagination.PageRequest) (apikeys.KeyList, error) {
		if tenantID != apiKeyTestTenantID || page.Size() != 7 || page.Cursor() == nil || page.Cursor().ID != apiKeyTestKeyID {
			t.Fatalf("list input = %s / size %d / cursor %#v", tenantID, page.Size(), page.Cursor())
		}
		key := apiKeyFixture([]authentication.Scope{authentication.ScopeRoomsRead})
		revokedAt := apiKeyTestNow.Add(-time.Minute)
		key.RevokedAt = &revokedAt
		return apikeys.KeyList{Keys: []apikeys.Key{key}, Page: pagination.Page{PageSize: 7, NextCursor: &next, HasMore: true}}, nil
	}}
	path := apiKeyCollectionPath(apiKeyTestTenantID) + "?page_size=7&cursor=" + cursor
	response := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(nil), apiKeyPrincipal(apiKeyTestTenantID, authentication.ScopeAPIKeysRead), http.MethodGet, path, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "hash") || strings.Contains(response.Body.String(), "chalk_sk_") {
		t.Fatalf("list leaked credential data: %s", response.Body.String())
	}
	var body apiKeyListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.APIKeys) != 1 || body.APIKeys[0].KeyPrefix != "prefix-safe" || body.Pagination.NextCursor == nil || !body.Pagination.HasMore {
		t.Fatalf("list response = %+v", body)
	}
}

func TestAPIKeyRotatePreservesScopesAndReturnsOnlyNewSecret(t *testing.T) {
	newExpiry := apiKeyTestNow.Add(2 * time.Hour)
	service := apiKeyServiceStub{rotate: func(_ context.Context, tenantID, id utilities.ID, input apikeys.RotateInput) (apikeys.RotateResult, error) {
		if tenantID != apiKeyTestTenantID || id != apiKeyTestKeyID || input.ExpiresAt == nil || !input.ExpiresAt.Equal(newExpiry) {
			t.Fatalf("rotate input = %s / %s / %+v", tenantID, id, input)
		}
		key := apiKeyFixture([]authentication.Scope{authentication.ScopeRoomsRead})
		key.ExpiresAt = newExpiry
		return apikeys.RotateResult{Key: key, RawKey: "chalk_sk_rotated.once"}, nil
	}}
	body := `{"expires_at":"2026-07-21T14:00:00Z"}`
	response := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(apiKeyMembershipReader{role: memberships.RoleAdmin}), apiKeyUserPrincipal(), http.MethodPost, apiKeyItemPath(apiKeyTestTenantID, apiKeyTestKeyID)+"/rotate", body)
	if response.Code != http.StatusOK || strings.Count(response.Body.String(), "chalk_sk_rotated.once") != 1 || strings.Contains(response.Body.String(), "chalk_sk_old") {
		t.Fatalf("rotate response = %d %s", response.Code, response.Body.String())
	}
}

func TestAPIKeyRevokeReturnsNoContent(t *testing.T) {
	called := false
	service := apiKeyServiceStub{revoke: func(_ context.Context, tenantID, id utilities.ID) error {
		called = true
		if tenantID != apiKeyTestTenantID || id != apiKeyTestKeyID {
			t.Fatalf("revoke input = %s / %s", tenantID, id)
		}
		return nil
	}}
	response := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(apiKeyMembershipReader{role: memberships.RoleOwner}), apiKeyUserPrincipal(), http.MethodDelete, apiKeyItemPath(apiKeyTestTenantID, apiKeyTestKeyID), "")
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 || !called {
		t.Fatalf("revoke response = %d %q, called %v", response.Code, response.Body.String(), called)
	}
}

func TestAPIKeyExpiryAndServiceErrorsUseStableResponses(t *testing.T) {
	service := apiKeyServiceStub{create: func(context.Context, apikeys.CreateInput) (apikeys.CreateResult, error) {
		return apikeys.CreateResult{}, apikeys.ErrInvalidExpiry
	}}
	response := serveAPIKeyRequest(t, service, authorization.NewTenantPolicy(apiKeyMembershipReader{role: memberships.RoleAdmin}), apiKeyUserPrincipal(), http.MethodPost, apiKeyCollectionPath(apiKeyTestTenantID), `{"name":"backend","scopes":["rooms:read"],"expires_at":"2020-01-01T00:00:00Z"}`)
	assertAPIKeyError(t, response, http.StatusBadRequest, "invalid_request")

	tests := []struct {
		err    error
		status int
		code   string
	}{
		{apikeys.ErrInvalidAPIKeyID, http.StatusBadRequest, "invalid_api_key_id"},
		{apikeys.ErrAPIKeyNotFound, http.StatusNotFound, "not_found"},
		{apikeys.ErrAPIKeyExpired, http.StatusConflict, "api_key_inactive"},
		{apikeys.ErrAPIKeyRevoked, http.StatusConflict, "api_key_inactive"},
		{errors.New("database unavailable"), http.StatusInternalServerError, "internal_error"},
	}
	for _, test := range tests {
		apiErr, ok := apiKeyAPIError(test.err)
		if !ok || apiErr.Status != test.status || apiErr.Code != test.code {
			t.Fatalf("map %v = %+v, %v", test.err, apiErr, ok)
		}
	}
}

func serveAPIKeyRequest(t testing.TB, service APIKeyService, authorizer TenantAuthorizer, principal authentication.Principal, method, path, body string) *httptest.ResponseRecorder {
	return serveAPIKeyRequestWithAudit(t, service, authorizer, nil, principal, method, path, body)
}

func serveAPIKeyRequestWithAudit(t testing.TB, service APIKeyService, authorizer TenantAuthorizer, audits APIKeyAuditWriter, principal authentication.Principal, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	router.Route("/v1", func(r chi.Router) { mountAPIKeyRoutes(r, service, authorizer, audits, RateLimitOptions{}) })
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if principal.IsAuthenticated() {
		request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), principal))
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func apiKeyUserPrincipal() authentication.Principal {
	return authentication.Principal{Kind: authentication.PrincipalUser, UserID: apiKeyTestUserID}
}

func apiKeyPrincipal(tenantID utilities.ID, scopes ...authentication.Scope) authentication.Principal {
	return authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenantID, APIKeyID: apiKeyTestCallerKey, Scopes: scopes}
}

func apiKeyFixture(scopes []authentication.Scope) apikeys.Key {
	return apikeys.Key{
		ID: apiKeyTestKeyID, TenantID: apiKeyTestTenantID, Name: "backend", Scopes: scopes,
		Prefix: "prefix-safe", CreatedByUserID: apiKeyTestUserID, ExpiresAt: apiKeyTestNow.Add(time.Hour),
		CreatedAt: apiKeyTestNow.Add(-time.Hour), UpdatedAt: apiKeyTestNow,
	}
}

func apiKeyCollectionPath(tenantID utilities.ID) string {
	return "/v1/tenants/" + tenantID.String() + "/api-keys"
}

func apiKeyItemPath(tenantID, keyID utilities.ID) string {
	return apiKeyCollectionPath(tenantID) + "/" + keyID.String()
}

func apiKeyContractHasError(contract APIRouteContract, code string) bool {
	for _, apiErr := range contract.Errors {
		if apiErr.Code == code {
			return true
		}
	}
	return false
}

func assertAPIKeyError(t testing.TB, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status || !strings.Contains(response.Body.String(), `"code":"`+code+`"`) {
		t.Fatalf("response = %d %s, want %d %s", response.Code, response.Body.String(), status, code)
	}
}

func apiKeyTestID(value string) utilities.ID {
	id, err := utilities.ParseID(value)
	if err != nil {
		panic(err)
	}
	return id
}

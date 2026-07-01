package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type readinessCheckerFunc func(context.Context) error

func (f readinessCheckerFunc) Check(ctx context.Context) error {
	return f(ctx)
}

type tenantService struct {
	availableRegions func(context.Context) ([]regions.Region, error)
	createTenant     func(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error)
	getTenant        func(context.Context, utilities.ID) (tenants.Tenant, error)
	listTenants      func(context.Context, pagination.PageRequest) (tenants.TenantList, error)
	updateTenant     func(context.Context, utilities.ID, tenants.UpdateTenantInput) (tenants.Tenant, error)
}

func (s tenantService) AvailableRegions(ctx context.Context) ([]regions.Region, error) {
	if s.availableRegions == nil {
		return nil, errors.New("unexpected available regions call")
	}
	return s.availableRegions(ctx)
}

func (s tenantService) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	if s.createTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected create tenant call")
	}
	return s.createTenant(ctx, input)
}

func (s tenantService) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	if s.getTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected get tenant call")
	}
	return s.getTenant(ctx, id)
}

func (s tenantService) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	if s.listTenants == nil {
		return tenants.TenantList{}, errors.New("unexpected list tenants call")
	}
	return s.listTenants(ctx, page)
}

func (s tenantService) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	if s.updateTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected update tenant call")
	}
	return s.updateTenant(ctx, id, input)
}

func TestHealth(t *testing.T) {
	res := request(t, http.MethodGet, "/healthz")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	contentType := res.Header().Get("Content-Type")
	if !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("content type = %q, want application/json", contentType)
	}

	var body struct {
		Status string `json:"status"`
	}
	decodeJSON(t, res, &body)

	if body.Status != "ok" {
		t.Fatalf("body status = %q, want ok", body.Status)
	}
}

func TestReady(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/readyz", httpapi.Options{
		Readiness: readinessCheckerFunc(func(context.Context) error {
			return nil
		}),
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Status       string            `json:"status"`
		Dependencies map[string]string `json:"dependencies"`
	}
	decodeJSON(t, res, &body)

	if body.Status != "ok" {
		t.Fatalf("body status = %q, want ok", body.Status)
	}
	if body.Dependencies["postgres"] != "ok" {
		t.Fatalf("postgres readiness = %q, want ok", body.Dependencies["postgres"])
	}
}

func TestReadyUnavailable(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/readyz", httpapi.Options{
		Readiness: readinessCheckerFunc(func(context.Context) error {
			return errors.New("database unavailable")
		}),
	})

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}

	body := decodeErrorResponse(t, res)
	if body.Error.Code != "service_unavailable" {
		t.Fatalf("error code = %q, want service_unavailable", body.Error.Code)
	}
	if body.Dependencies["postgres"] != "unavailable" {
		t.Fatalf("postgres readiness = %q, want unavailable", body.Dependencies["postgres"])
	}
}

func TestReadyWithoutChecker(t *testing.T) {
	res := request(t, http.MethodGet, "/readyz")

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}

	body := decodeErrorResponse(t, res)
	if body.Error.Code != "service_unavailable" {
		t.Fatalf("error code = %q, want service_unavailable", body.Error.Code)
	}
	if body.Dependencies["postgres"] != "unavailable" {
		t.Fatalf("postgres readiness = %q, want unavailable", body.Dependencies["postgres"])
	}
}

func TestUnknownRoute(t *testing.T) {
	res := request(t, http.MethodGet, "/missing")

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNotFound)
	}

	assertErrorCode(t, res, "not_found")
}

func TestMethodNotAllowed(t *testing.T) {
	res := request(t, http.MethodPost, "/healthz")

	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusMethodNotAllowed)
	}

	assertErrorCode(t, res, "method_not_allowed")
}

func TestMiddleware(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/healthz", httpapi.Options{
		Middleware: []func(http.Handler) http.Handler{
			func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					called = true
					w.Header().Set("X-Test-Middleware", "ok")
					next.ServeHTTP(w, r)
				})
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if !called {
		t.Fatal("middleware was not called")
	}
	if res.Header().Get("X-Test-Middleware") != "ok" {
		t.Fatalf("middleware header = %q, want ok", res.Header().Get("X-Test-Middleware"))
	}
}

func TestProfilerMount(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/debug/healthz", httpapi.Options{
		Profiler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeProfilerTestResponse(w)
		}),
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if strings.TrimSpace(res.Body.String()) != "profiler" {
		t.Fatalf("profiler body = %q, want profiler", res.Body.String())
	}
}

func TestCORSPreflightAllowedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/v1/tenants", nil)
	req.Header.Set("Origin", "https://app.chalk.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	res := httptest.NewRecorder()
	httpapi.NewRouter(httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
	}).ServeHTTP(res, req)

	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNoContent)
	}
	if res.Header().Get("Access-Control-Allow-Origin") != "https://app.chalk.test" {
		t.Fatalf("allow origin = %q, want configured origin", res.Header().Get("Access-Control-Allow-Origin"))
	}
	if res.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("allow methods header was empty")
	}
}

func TestCORSPreflightRejectsUnknownOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/v1/tenants", nil)
	req.Header.Set("Origin", "https://evil.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	res := httptest.NewRecorder()

	httpapi.NewRouter(httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
	}).ServeHTTP(res, req)

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	assertErrorCode(t, res, "cors_origin_forbidden")
}

func TestGetTenant(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	defaultRegion := "us"
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	updatedAt := time.Date(2026, 6, 30, 10, 5, 0, 0, time.UTC)

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID, httpapi.Options{
		Tenants: tenantService{
			getTenant: func(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}

				return tenants.Tenant{
					ID:            id,
					Name:          "Acme",
					DefaultRegion: &defaultRegion,
					UpdatedAt:     updatedAt,
					CreatedAt:     createdAt,
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
		Website       *string `json:"website"`
		UpdatedAt     string  `json:"updated_at"`
		CreatedAt     string  `json:"created_at"`
	}
	decodeJSON(t, res, &body)

	if body.ID != tenantID {
		t.Fatalf("tenant id = %q, want %q", body.ID, tenantID)
	}
	if body.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", body.Name)
	}
	if body.DefaultRegion == nil || *body.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", body.DefaultRegion)
	}
	if body.Website != nil {
		t.Fatalf("website = %v, want nil", body.Website)
	}
	if body.CreatedAt != "2026-06-30T10:00:00Z" {
		t.Fatalf("created at = %q, want 2026-06-30T10:00:00Z", body.CreatedAt)
	}
	if body.UpdatedAt != "2026-06-30T10:05:00Z" {
		t.Fatalf("updated at = %q, want 2026-06-30T10:05:00Z", body.UpdatedAt)
	}
}

func TestGetTenantRejectsInvalidID(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/not-a-uuid", httpapi.Options{
		Tenants: tenantService{
			getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
				called = true
				return tenants.Tenant{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_tenant_id")
}

func TestGetTenantNotFound(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111", httpapi.Options{
		Tenants: tenantService{
			getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
				return tenants.Tenant{}, tenants.ErrTenantNotFound
			},
		},
	})

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNotFound)
	}
	assertErrorCode(t, res, "not_found")
}

func TestGetTenantWithoutService(t *testing.T) {
	res := request(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111")

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}
	assertErrorCode(t, res, "service_unavailable")
}

func TestListTenants(t *testing.T) {
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	nextCreatedAt := time.Date(2026, 6, 30, 9, 0, 0, 0, time.UTC)
	nextID := mustTenantID(t, "22222222-2222-2222-2222-222222222222")

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Size() != pagination.DefaultPageSize {
					t.Fatalf("page size = %d, want %d", page.Size(), pagination.DefaultPageSize)
				}
				if page.Cursor() != nil {
					t.Fatalf("cursor = %#v, want nil", page.Cursor())
				}

				return tenants.TenantList{
					Tenants: []tenants.Tenant{
						{
							ID:        mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
							Name:      "Acme",
							CreatedAt: createdAt,
							UpdatedAt: createdAt,
						},
					},
					Page: pagination.Page{
						PageSize: pagination.DefaultPageSize,
						HasMore:  true,
						NextCursor: &pagination.Cursor{
							CreatedAt: nextCreatedAt,
							ID:        nextID,
						},
					},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Tenants []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"created_at"`
			UpdatedAt string `json:"updated_at"`
		} `json:"tenants"`
		Pagination struct {
			PageSize   int     `json:"page_size"`
			NextCursor *string `json:"next_cursor"`
			HasMore    bool    `json:"has_more"`
		} `json:"pagination"`
	}
	decodeJSON(t, res, &body)

	if len(body.Tenants) != 1 {
		t.Fatalf("tenant count = %d, want 1", len(body.Tenants))
	}
	if body.Tenants[0].Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", body.Tenants[0].Name)
	}
	if body.Pagination.PageSize != pagination.DefaultPageSize {
		t.Fatalf("page size = %d, want %d", body.Pagination.PageSize, pagination.DefaultPageSize)
	}
	if !body.Pagination.HasMore {
		t.Fatal("has_more = false, want true")
	}
	if body.Pagination.NextCursor == nil {
		t.Fatal("next cursor was nil")
	}

	decodedCursor, err := pagination.DecodeCursor(*body.Pagination.NextCursor)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if decodedCursor.ID.String() != nextID.String() {
		t.Fatalf("cursor id = %q, want %q", decodedCursor.ID.String(), nextID.String())
	}
	if !decodedCursor.CreatedAt.Equal(nextCreatedAt) {
		t.Fatalf("cursor created at = %v, want %v", decodedCursor.CreatedAt, nextCreatedAt)
	}
}

func TestListTenantsParsesPageSize(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?page_size=10", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", page.Size())
				}

				return tenants.TenantList{
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestListTenantsParsesCursor(t *testing.T) {
	cursor := pagination.Cursor{
		CreatedAt: time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC),
		ID:        mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
	}
	encodedCursor, err := pagination.EncodeCursor(cursor)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?cursor="+encodedCursor, httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Cursor() == nil {
					t.Fatal("cursor was nil")
				}
				if page.Cursor().ID.String() != cursor.ID.String() {
					t.Fatalf("cursor id = %q, want %q", page.Cursor().ID.String(), cursor.ID.String())
				}

				return tenants.TenantList{
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestListTenantsRejectsInvalidPageSize(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?page_size=0", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
				called = true
				return tenants.TenantList{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_page_size")
}

func TestListTenantsRejectsInvalidCursor(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants?cursor=not-a-cursor", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
				called = true
				return tenants.TenantList{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_cursor")
}

func TestCreateTenant(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"

	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", `{"name":"Acme","default_region":"us"}`, httpapi.Options{
		Tenants: tenantService{
			createTenant: func(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
				if input.Name != "Acme" {
					t.Fatalf("tenant name = %q, want Acme", input.Name)
				}
				if input.DefaultRegion == nil || *input.DefaultRegion != "us" {
					t.Fatalf("default region = %v, want us", input.DefaultRegion)
				}

				return tenants.Tenant{
					ID:            mustTenantID(t, tenantID),
					Name:          input.Name,
					DefaultRegion: input.DefaultRegion,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
	}
	decodeJSON(t, res, &body)

	if body.ID != tenantID {
		t.Fatalf("tenant id = %q, want %q", body.ID, tenantID)
	}
	if body.DefaultRegion == nil || *body.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", body.DefaultRegion)
	}
}

func TestCreateTenantRejectsInvalidRegion(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", `{"name":"Acme","default_region":"mars"}`, httpapi.Options{
		Tenants: tenantService{
			createTenant: func(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error) {
				return tenants.Tenant{}, tenants.ErrInvalidTenantRegion
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	assertErrorCode(t, res, "invalid_tenant_region")
}

func TestUpdateTenantClearsNullableField(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"

	res := requestWithOptionsAndBody(t, http.MethodPatch, "/v1/tenants/"+tenantID, `{"default_region":null}`, httpapi.Options{
		Tenants: tenantService{
			updateTenant: func(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}
				if !input.DefaultRegion.Set {
					t.Fatal("default region was not marked as set")
				}
				if input.DefaultRegion.Value != nil {
					t.Fatalf("default region = %v, want nil", input.DefaultRegion.Value)
				}

				return tenants.Tenant{
					ID:   id,
					Name: "Acme",
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		DefaultRegion *string `json:"default_region"`
	}
	decodeJSON(t, res, &body)

	if body.DefaultRegion != nil {
		t.Fatalf("default region = %v, want nil", body.DefaultRegion)
	}
}

func TestListRegions(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/regions", httpapi.Options{
		Tenants: tenantService{
			availableRegions: func(context.Context) ([]regions.Region, error) {
				return []regions.Region{
					{Code: "us", Name: "United States"},
					{Code: "sg", Name: "Singapore"},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Regions []struct {
			Code string `json:"code"`
			Name string `json:"name"`
		} `json:"regions"`
	}
	decodeJSON(t, res, &body)

	if len(body.Regions) != 2 {
		t.Fatalf("region count = %d, want 2", len(body.Regions))
	}
	if body.Regions[0].Code != "us" || body.Regions[1].Code != "sg" {
		t.Fatalf("regions = %#v, want us and sg", body.Regions)
	}
}

func request(t *testing.T, method string, path string) *httptest.ResponseRecorder {
	t.Helper()

	return requestWithOptions(t, method, path, httpapi.Options{})
}

func requestWithOptions(t *testing.T, method string, path string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	return requestWithOptionsAndBody(t, method, path, "", options)
}

func requestWithOptionsAndBody(t *testing.T, method string, path string, body string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	handler := httpapi.NewRouter(options)
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	res := httptest.NewRecorder()

	handler.ServeHTTP(res, req)

	return res
}

func assertErrorCode(t *testing.T, res *httptest.ResponseRecorder, want string) {
	t.Helper()

	body := decodeErrorResponse(t, res)

	if body.Error.Code != want {
		t.Fatalf("error code = %q, want %q", body.Error.Code, want)
	}
}

func decodeErrorResponse(t *testing.T, res *httptest.ResponseRecorder) errorResponseBody {
	t.Helper()

	var body errorResponseBody
	decodeJSON(t, res, &body)
	return body
}

func decodeJSON(t *testing.T, res *httptest.ResponseRecorder, target any) {
	t.Helper()

	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

type errorResponseBody struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
	Dependencies map[string]string `json:"dependencies"`
}

func mustTenantID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}

func writeProfilerTestResponse(w http.ResponseWriter) {
	_, _ = w.Write([]byte("profiler"))
}

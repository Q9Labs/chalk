package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type readinessCheckerFunc func(context.Context) error

func (f readinessCheckerFunc) Check(ctx context.Context) error {
	return f(ctx)
}

type tenantGetterFunc func(context.Context, tenants.TenantID) (tenants.Tenant, error)

func (f tenantGetterFunc) GetTenant(ctx context.Context, id tenants.TenantID) (tenants.Tenant, error) {
	return f(ctx, id)
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

func TestGetTenant(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	defaultRegion := "iad"

	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID, httpapi.Options{
		Tenants: tenantGetterFunc(func(ctx context.Context, id tenants.TenantID) (tenants.Tenant, error) {
			if id.String() != tenantID {
				t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
			}

			return tenants.Tenant{
				ID:            id,
				Name:          "Acme",
				DefaultRegion: &defaultRegion,
			}, nil
		}),
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
		Website       *string `json:"website"`
	}
	decodeJSON(t, res, &body)

	if body.ID != tenantID {
		t.Fatalf("tenant id = %q, want %q", body.ID, tenantID)
	}
	if body.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", body.Name)
	}
	if body.DefaultRegion == nil || *body.DefaultRegion != "iad" {
		t.Fatalf("default region = %v, want iad", body.DefaultRegion)
	}
	if body.Website != nil {
		t.Fatalf("website = %v, want nil", body.Website)
	}
}

func TestGetTenantRejectsInvalidID(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/v1/tenants/not-a-uuid", httpapi.Options{
		Tenants: tenantGetterFunc(func(context.Context, tenants.TenantID) (tenants.Tenant, error) {
			called = true
			return tenants.Tenant{}, nil
		}),
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
		Tenants: tenantGetterFunc(func(context.Context, tenants.TenantID) (tenants.Tenant, error) {
			return tenants.Tenant{}, tenants.ErrTenantNotFound
		}),
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

func request(t *testing.T, method string, path string) *httptest.ResponseRecorder {
	t.Helper()

	return requestWithOptions(t, method, path, httpapi.Options{})
}

func requestWithOptions(t *testing.T, method string, path string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	handler := httpapi.NewRouter(options)
	req := httptest.NewRequest(method, path, nil)
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

package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestHelperDeviceLookupQuotaSeparatesTenants(t *testing.T) {
	options := DefaultRateLimitOptions()
	attempt := func(tenant utilities.ID) error {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		ctx := authentication.ContextWithPrincipal(r.Context(), authentication.Principal{
			Kind: authentication.PrincipalService, ServiceID: "dashboard",
		})
		routes := chi.NewRouteContext()
		routes.URLParams.Add("tenant_id", tenant.String())
		return checkRateLimit(options, helperLookupLimit, httptest.NewRecorder(),
			r.WithContext(context.WithValue(ctx, chi.RouteCtxKey, routes)))
	}
	first, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	second, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	for range helperLookupLimit.Limit {
		if err := attempt(first); err != nil {
			t.Fatal(err)
		}
	}
	if err := attempt(first); err == nil {
		t.Fatal("lookup quota did not exhaust")
	}
	if err := attempt(second); err != nil {
		t.Fatalf("another tenant spent this tenant's lookup quota: %v", err)
	}
}

package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type storedSpaces struct {
	spaces.Repository
	created spaces.CreateSpaceInput
}

func (r *storedSpaces) CreateSpaceIdempotent(_ context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	r.created = input
	return spaces.Space{ID: input.ID, TenantID: input.TenantID, Name: input.Name, Slug: input.Slug, MediaPlane: input.MediaPlane, MediaPlaneSetting: input.MediaPlaneSetting}, nil
}

// With the own SFU as the deployment default, Create Space with no media_plane answers 201
// and the Space inherits, instead of the 400 space.invalid_media_plane it used to give.
func TestCreateSpaceWithNoPlaneUnderTheOwnSFUDefault(t *testing.T) {
	tenant, _ := utilities.NewID()
	repository := &storedSpaces{}
	service := spaces.NewServiceWithDefaultProvider(repository, spaces.MediaPlaneProviderChalkSFU)
	endpoint := createSpaceEndpoint(service, allowAllTenants{})
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenant})
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"Team","slug":"team"}`)).WithContext(ctx)
	request.Header.Set(idempotencyKeyHeader, "own-sfu-default-space-0001")
	routed := chi.NewRouteContext()
	routed.URLParams.Add("tenant_id", tenant.String())
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routed))

	response := httptest.NewRecorder()
	endpoint.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("response = %d %s, want 201", response.Code, response.Body.String())
	}
	if repository.created.MediaPlaneSetting != nil {
		t.Errorf("the Space stored its own plane %v, want it to inherit", *repository.created.MediaPlaneSetting)
	}
}

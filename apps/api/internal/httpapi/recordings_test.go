package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingRouteProbe struct {
	deleteErr   error
	deleteCalls int
	deletedBy   []string
}

func (p *recordingRouteProbe) Get(context.Context, utilities.ID, utilities.ID) (recordings.Recording, error) {
	return recordings.Recording{}, recordings.ErrRecordingNotFound
}

func (p *recordingRouteProbe) List(context.Context, utilities.ID, utilities.ID, utilities.ID, pagination.PageRequest) (recordings.RecordingList, error) {
	return recordings.RecordingList{}, nil
}

func (p *recordingRouteProbe) Delete(_ context.Context, _ utilities.ID, _ utilities.ID, deletedBy string) error {
	p.deleteCalls++
	p.deletedBy = append(p.deletedBy, deletedBy)
	return p.deleteErr
}

type recordingRouteExportProbe struct{}

func (recordingRouteExportProbe) RequestExport(context.Context, recordingpipeline.ExportInput) (recordingpipeline.Job, error) {
	return recordingpipeline.Job{}, recordingpipeline.ErrPipelineNotFound
}

func (recordingRouteExportProbe) GetArtifactState(context.Context, utilities.ID, utilities.ID) (recordingpipeline.ArtifactState, error) {
	return recordingpipeline.ArtifactState{}, recordingpipeline.ErrPipelineNotFound
}

type recordingRouteDownloadProbe struct{}

func (recordingRouteDownloadProbe) CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
}

func recordingDeleteRouter(service RecordingService, key *authentication.Principal) http.Handler {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if key != nil {
				r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), *key))
			}
			next.ServeHTTP(w, r)
		})
	})
	for _, endpoint := range recordingEndpoints(service, recordingRouteExportProbe{}, recordingRouteDownloadProbe{}, authorization.NewTenantPolicy(nil, nil)) {
		endpoint.Mount(router, RateLimitOptions{})
	}
	return router
}

func TestDeleteRecordingAuthorization(t *testing.T) {
	const (
		tenant    = "11111111-1111-4111-8111-111111111111"
		otherTeam = "22222222-2222-4222-8222-222222222222"
		recording = "33333333-3333-4333-8333-333333333333"
		keyID     = "55555555-5555-4555-8555-555555555555"
	)
	path := "/tenants/" + tenant + "/recordings/" + recording
	principal := func(tenantID string, scopes ...authentication.Scope) *authentication.Principal {
		return &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: mustID(t, keyID), TenantID: mustID(t, tenantID), Scopes: scopes}
	}

	for _, tc := range []struct {
		name string
		key  *authentication.Principal
		want int
	}{
		{"wrong tenant", principal(otherTeam, authentication.ScopeRecordingsDelete), http.StatusForbidden},
		{"missing scope", principal(tenant, authentication.ScopeRecordingsRead), http.StatusForbidden},
		{"delete scope", principal(tenant, authentication.ScopeRecordingsDelete), http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe := &recordingRouteProbe{}
			response := httptest.NewRecorder()
			recordingDeleteRouter(probe, tc.key).ServeHTTP(response, httptest.NewRequest(http.MethodDelete, path, nil))
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
			wantCalls := 0
			if tc.want == http.StatusNoContent {
				wantCalls = 1
			}
			if probe.deleteCalls != wantCalls {
				t.Fatalf("delete calls = %d, want %d", probe.deleteCalls, wantCalls)
			}
		})
	}
}

func TestDeleteRecordingRouteIsIdempotentAndAuditsTheCredential(t *testing.T) {
	const (
		tenant    = "11111111-1111-4111-8111-111111111111"
		recording = "33333333-3333-4333-8333-333333333333"
		keyID     = "55555555-5555-4555-8555-555555555555"
	)
	probe := &recordingRouteProbe{}
	key := &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: mustID(t, keyID), TenantID: mustID(t, tenant), Scopes: []authentication.Scope{authentication.ScopeRecordingsDelete}}
	router := recordingDeleteRouter(probe, key)
	path := "/tenants/" + tenant + "/recordings/" + recording

	for attempt := 1; attempt <= 2; attempt++ {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, path, nil))
		if response.Code != http.StatusNoContent {
			t.Fatalf("attempt %d status = %d: %s", attempt, response.Code, response.Body.String())
		}
	}
	if probe.deleteCalls != 2 {
		t.Fatalf("delete calls = %d, want both idempotent attempts", probe.deleteCalls)
	}
	wantActor := "api_key:" + keyID
	for _, actor := range probe.deletedBy {
		if actor != wantActor {
			t.Fatalf("deletedBy = %q, want %q", actor, wantActor)
		}
	}
}

func TestDeleteRecordingRouteMapsActiveWorkToConflict(t *testing.T) {
	const (
		tenant    = "11111111-1111-4111-8111-111111111111"
		recording = "33333333-3333-4333-8333-333333333333"
		keyID     = "55555555-5555-4555-8555-555555555555"
	)
	probe := &recordingRouteProbe{deleteErr: recordings.ErrRecordingDeleteConflict}
	key := &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: mustID(t, keyID), TenantID: mustID(t, tenant), Scopes: []authentication.Scope{authentication.ScopeRecordingsDelete}}
	response := httptest.NewRecorder()
	recordingDeleteRouter(probe, key).ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/tenants/"+tenant+"/recordings/"+recording, nil))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"recording.delete_conflict"`) {
		t.Fatalf("status/body = %d %s", response.Code, response.Body.String())
	}
}

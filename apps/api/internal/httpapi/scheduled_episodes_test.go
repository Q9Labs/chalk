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
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/scheduledepisodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type scheduledEpisodeProbe struct {
	put       scheduledepisodes.PutInput
	putCalls  int
	cancelled []utilities.ID
	result    scheduledepisodes.ScheduledEpisode
	err       error
}

func (p *scheduledEpisodeProbe) Put(_ context.Context, input scheduledepisodes.PutInput) (scheduledepisodes.ScheduledEpisode, error) {
	p.put, p.putCalls = input, p.putCalls+1
	return p.result, p.err
}

func (p *scheduledEpisodeProbe) Get(context.Context, utilities.ID, utilities.ID, utilities.ID) (scheduledepisodes.ScheduledEpisode, error) {
	return p.result, p.err
}

func (p *scheduledEpisodeProbe) Cancel(_ context.Context, _, _, id utilities.ID) error {
	p.cancelled = append(p.cancelled, id)
	return p.err
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// scheduledEpisodeRouter mounts the routes behind a caller that holds the given API key.
func scheduledEpisodeRouter(service ScheduledEpisodeService, key *authentication.Principal) http.Handler {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if key != nil {
				r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), *key))
			}
			next.ServeHTTP(w, r)
		})
	})
	for _, endpoint := range scheduledEpisodeEndpoints(service, authorization.NewTenantPolicy(nil, nil)) {
		endpoint.Mount(router, RateLimitOptions{})
	}
	return router
}

func TestScheduledEpisodeRoutes(t *testing.T) {
	const (
		tenant    = "11111111-1111-4111-8111-111111111111"
		otherTeam = "22222222-2222-4222-8222-222222222222"
		space     = "33333333-3333-4333-8333-333333333333"
		booking   = "44444444-4444-4444-8444-444444444444"
	)
	path := "/tenants/" + tenant + "/spaces/" + space + "/scheduled-episodes/" + booking
	apiKey := func(tenantID string, scopes ...authentication.Scope) *authentication.Principal {
		return &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: mustID(t, "55555555-5555-4555-8555-555555555555"), TenantID: mustID(t, tenantID), Scopes: scopes}
	}
	reader := apiKey(tenant, authentication.ScopeEpisodesRead)
	writer := apiKey(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	body := `{"starts_at":"2027-03-01T10:00:00+04:00","expected_ends_at":"2027-03-01T11:00:00+04:00","expected_participants":[{"name":"Ada","role":"host","identity_external_id":"ada-1"}],"metadata":{"booking":"b-1"}}`

	for _, tc := range []struct {
		name   string
		method string
		path   string
		body   string
		key    *authentication.Principal
		err    error
		want   int
		code   string
	}{
		{"no credential", http.MethodPut, path, body, nil, nil, http.StatusUnauthorized, "access.unauthenticated"},
		{"a key of another Tenant", http.MethodPut, path, body, apiKey(otherTeam, authentication.ScopeEpisodesWrite), nil, http.StatusForbidden, "access.forbidden"},
		{"a read-only key cannot put", http.MethodPut, path, body, reader, nil, http.StatusForbidden, "access.forbidden"},
		{"a read-only key cannot cancel", http.MethodDelete, path, "", reader, nil, http.StatusForbidden, "access.forbidden"},
		{"a read-only key reads", http.MethodGet, path, "", reader, nil, http.StatusOK, ""},
		{"bad booking id", http.MethodPut, "/tenants/" + tenant + "/spaces/" + space + "/scheduled-episodes/not-a-uuid", body, writer, nil, http.StatusBadRequest, "scheduled_episode.invalid_id"},
		{"missing start", http.MethodPut, path, `{"expected_ends_at":"2027-03-01T11:00:00Z"}`, writer, nil, http.StatusBadRequest, "scheduled_episode.invalid_schedule"},
		{"start without an offset", http.MethodPut, path, `{"starts_at":"2027-03-01T10:00:00","expected_ends_at":"2027-03-01T11:00:00Z"}`, writer, nil, http.StatusBadRequest, "request.invalid"},
		{"unknown field", http.MethodPut, path, `{"starts_at":"2027-03-01T10:00:00Z","expected_ends_at":"2027-03-01T11:00:00Z","status":"cancelled"}`, writer, nil, http.StatusBadRequest, "request.invalid"},
		{"put", http.MethodPut, path, body, writer, nil, http.StatusOK, ""},
		{"put of a cancelled booking", http.MethodPut, path, body, writer, scheduledepisodes.ErrCancelled, http.StatusConflict, "scheduled_episode.cancelled"},
		{"put in an archived Space", http.MethodPut, path, body, writer, scheduledepisodes.ErrSpaceArchived, http.StatusConflict, "scheduled_episode.space_archived"},
		{"put with a bad schedule", http.MethodPut, path, body, writer, scheduledepisodes.ErrInvalidSchedule, http.StatusBadRequest, "scheduled_episode.invalid_schedule"},
		{"put in an unknown Space", http.MethodPut, path, body, writer, scheduledepisodes.ErrSpaceNotFound, http.StatusNotFound, "space.not_found"},
		{"get of an unknown booking", http.MethodGet, path, "", reader, scheduledepisodes.ErrNotFound, http.StatusNotFound, "scheduled_episode.not_found"},
		{"cancel", http.MethodDelete, path, "", writer, nil, http.StatusNoContent, ""},
		{"cancel in an unknown Space", http.MethodDelete, path, "", writer, scheduledepisodes.ErrSpaceNotFound, http.StatusNotFound, "space.not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe := &scheduledEpisodeProbe{err: tc.err, result: scheduledepisodes.ScheduledEpisode{
				TenantID: mustID(t, tenant), SpaceID: mustID(t, space), ID: mustID(t, booking),
				Expectation: scheduledepisodes.Expectation{
					StartsAt:       time.Date(2027, 3, 1, 6, 0, 0, 0, time.UTC),
					ExpectedEndsAt: time.Date(2027, 3, 1, 7, 0, 0, 0, time.UTC),
				},
				CreatedAt: time.Date(2026, 11, 25, 0, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 11, 25, 0, 0, 0, 0, time.UTC),
			}}
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			response := httptest.NewRecorder()
			scheduledEpisodeRouter(probe, tc.key).ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
			if tc.code != "" && !strings.Contains(response.Body.String(), `"`+tc.code+`"`) {
				t.Fatalf("body = %s, want code %q", response.Body.String(), tc.code)
			}
			if tc.want == http.StatusUnauthorized || tc.want == http.StatusForbidden || tc.want == http.StatusBadRequest && tc.err == nil {
				if probe.putCalls != 0 || len(probe.cancelled) != 0 {
					t.Fatal("a refused request reached the service")
				}
			}
		})
	}

	t.Run("put hands the service the whole plan qualified by Tenant and Space, in UTC", func(t *testing.T) {
		probe := &scheduledEpisodeProbe{}
		response := httptest.NewRecorder()
		scheduledEpisodeRouter(probe, writer).ServeHTTP(response, httptest.NewRequest(http.MethodPut, path, strings.NewReader(body)))
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", response.Code, response.Body.String())
		}
		got := probe.put
		if got.TenantID.String() != tenant || got.SpaceID.String() != space || got.ID.String() != booking {
			t.Fatalf("put identity = %v %v %v", got.TenantID, got.SpaceID, got.ID)
		}
		if want := time.Date(2027, 3, 1, 6, 0, 0, 0, time.UTC); !got.StartsAt.Equal(want) {
			t.Fatalf("starts_at = %v, want the same instant as %v", got.StartsAt, want)
		}
		if len(got.ExpectedParticipants) != 1 || got.ExpectedParticipants[0].IdentityExternalID != "ada-1" || string(got.Metadata) != `{"booking":"b-1"}` {
			t.Fatalf("put expectation = %+v", got.Expectation)
		}
	})

	t.Run("the response reports UTC and the status", func(t *testing.T) {
		cancelledAt := time.Date(2026, 11, 26, 0, 0, 0, 0, time.UTC)
		probe := &scheduledEpisodeProbe{result: scheduledepisodes.ScheduledEpisode{
			TenantID: mustID(t, tenant), SpaceID: mustID(t, space), ID: mustID(t, booking),
			Expectation: scheduledepisodes.Expectation{StartsAt: time.Date(2027, 3, 1, 6, 0, 0, 0, time.UTC), ExpectedEndsAt: time.Date(2027, 3, 1, 7, 0, 0, 0, time.UTC)},
			CancelledAt: &cancelledAt,
		}}
		response := httptest.NewRecorder()
		scheduledEpisodeRouter(probe, reader).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		var got scheduledEpisodeResponse
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Status != "cancelled" || got.StartsAt != "2027-03-01T06:00:00Z" || got.CancelledAt == nil || got.ExpectedParticipants == nil {
			t.Fatalf("response = %+v", got)
		}
	})

	t.Run("an unready service answers 503", func(t *testing.T) {
		var service ScheduledEpisodeService
		response := httptest.NewRecorder()
		scheduledEpisodeRouter(service, writer).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d", response.Code)
		}
	})

	t.Run("an unexpected failure is not reported as the caller's mistake", func(t *testing.T) {
		probe := &scheduledEpisodeProbe{err: errors.New("database down")}
		response := httptest.NewRecorder()
		scheduledEpisodeRouter(probe, writer).ServeHTTP(response, httptest.NewRequest(http.MethodDelete, path, nil))
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d", response.Code)
		}
	})
}

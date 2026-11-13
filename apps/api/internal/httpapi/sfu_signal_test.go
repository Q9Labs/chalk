package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func signalSubject(t *testing.T) accessgrants.Subject {
	id := func(value string) utilities.ID {
		parsed, err := utilities.ParseID(value)
		if err != nil {
			panic(err)
		}
		return parsed
	}
	return accessgrants.Subject{
		TenantID:              id("11111111-1111-4111-8111-111111111111"),
		SpaceID:               id("22222222-2222-4222-8222-222222222222"),
		EpisodeID:             id("33333333-3333-4333-8333-333333333333"),
		ParticipantID:         id("44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 7,
		Provider:              string(mediaplane.ProviderChalkSFU),
		ConnectionID:          "connection-123",
	}
}

func signalRouter(t *testing.T, plane signalPlane, registry signalRegistry, limiter *signalLimiter) http.Handler {
	t.Helper()
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, plane)
	subject := signalSubject(t)
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(accessgrants.WithSubject(r.Context(), subject)))
		})
	})
	router.Route("/v1", func(v1 chi.Router) {
		for _, endpoint := range sfuSignalingEndpoints(signalSpaces{}, signalEpisodes{}, signalTenants{}, signalResolver{service: &service}, registry) {
			endpoint.Mount(v1, RateLimitOptions{Limiter: limiter, Now: time.Now})
		}
	})
	return router
}

func signalPath(suffix string) string {
	subject := signalSubject(nil)
	return fmt.Sprintf("/v1/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/%s", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID, suffix)
}

type signalOutcome struct {
	status   int
	body     string
	policies []string
}

func callSignal(t *testing.T, plane signalPlane, registry signalRegistry, exhaustAfter int, method, path, body string) signalOutcome {
	t.Helper()
	limiter := &signalLimiter{exhaustAfter: exhaustAfter}
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	signalRouter(t, plane, registry, limiter).ServeHTTP(recorder, request)
	return signalOutcome{status: recorder.Code, body: strings.TrimSpace(recorder.Body.String()), policies: limiter.policies}
}

// signalCase is one operation seen through its per-operation route and through the unified route.
type signalCase struct {
	name    string
	method  string
	suffix  string
	legacy  string
	unified string
}

var signalCases = []signalCase{
	{"publications", http.MethodGet, "publications", ``, `{"op":"publications"}`},
	{"subscriptions", http.MethodGet, "subscriptions", ``, `{"op":"subscriptions"}`},
	{
		"tracks", http.MethodPost, "tracks?allow_partial_remote_tracks=true&replacement_cause=ice_failed",
		`{"connection_id":"connection-123","session_description":{"sdp":"offer-sdp","type":"offer"},"tracks":[{"location":"local","mid":"0","trackName":"camera","source":"camera"}]}`,
		`{"op":"tracks","allow_partial_remote_tracks":true,"replacement_cause":"ice_failed","connection_id":"connection-123","session_description":{"sdp":"offer-sdp","type":"offer"},"tracks":[{"location":"local","mid":"0","trackName":"camera","source":"camera"}]}`,
	},
	{
		"tracks_pull_published", http.MethodPost, "tracks?allow_partial_remote_tracks=true",
		`{"connection_id":"connection-123","tracks":[],"pull_published_audio":true}`,
		`{"op":"tracks","allow_partial_remote_tracks":true,"connection_id":"connection-123","tracks":[],"pull_published_audio":true}`,
	},
	{
		"tracks_close", http.MethodPut, "tracks/close",
		`{"connection_id":"connection-123","session_description":{"sdp":"offer-sdp","type":"offer"},"tracks":[{"mid":"0","source":"camera","publication_id":"publication-1"}],"force":true}`,
		`{"op":"tracks_close","connection_id":"connection-123","session_description":{"sdp":"offer-sdp","type":"offer"},"close_tracks":[{"mid":"0","source":"camera","publication_id":"publication-1"}],"force":true}`,
	},
	{
		"tracks_update", http.MethodPut, "tracks/update",
		`{"connection_id":"connection-123","tracks":[{"location":"remote","mid":"3","trackName":"video","sessionId":"session-2","paused":true}]}`,
		`{"op":"tracks_update","connection_id":"connection-123","tracks":[{"location":"remote","mid":"3","trackName":"video","sessionId":"session-2","paused":true}]}`,
	},
	{
		"renegotiate", http.MethodPost, "renegotiate",
		`{"connection_id":"connection-123","session_description":{"sdp":"answer-sdp","type":"answer"}}`,
		`{"op":"renegotiate","connection_id":"connection-123","session_description":{"sdp":"answer-sdp","type":"answer"}}`,
	},
}

// Every operation answers through the unified route exactly as through its own
// route: the same status, body and quota, whether it succeeds, fails in the
// media plane or the publication registry, or finds its quota spent.
func TestSFUSignalMatchesPerOperationRoutes(t *testing.T) {
	scenarios := []struct {
		name         string
		plane        signalPlane
		registry     signalRegistry
		exhaustAfter int
	}{
		{"success", signalPlane{}, signalRegistry{}, 1000},
		{"media plane unavailable", signalPlane{err: mediaplane.ErrPlaneUnavailable}, signalRegistry{}, 1000},
		{"connection not found", signalPlane{err: mediaplane.ErrConnectionNotFound}, signalRegistry{}, 1000},
		{"invalid signal request", signalPlane{err: mediaplane.ErrInvalidSignalRequest}, signalRegistry{}, 1000},
		{"registry unavailable", signalPlane{}, signalRegistry{err: mediapublications.ErrUnavailable}, 1000},
		{"quota spent", signalPlane{}, signalRegistry{}, 0},
	}
	for _, scenario := range scenarios {
		for _, operation := range signalCases {
			t.Run(scenario.name+"/"+operation.name, func(t *testing.T) {
				legacy := callSignal(t, scenario.plane, scenario.registry, scenario.exhaustAfter, operation.method, signalPath(operation.suffix), operation.legacy)
				unified := callSignal(t, scenario.plane, scenario.registry, scenario.exhaustAfter, http.MethodPost, signalPath("signal"), operation.unified)
				if scenario.name == "success" && legacy.status != http.StatusOK {
					t.Fatalf("per-operation route answered %d %s, want a success to compare against", legacy.status, legacy.body)
				}
				if legacy.status != unified.status || legacy.body != unified.body {
					t.Errorf("unified route answered %d %s, per-operation route %d %s", unified.status, unified.body, legacy.status, legacy.body)
				}
				if strings.Join(legacy.policies, ",") != strings.Join(unified.policies, ",") {
					t.Errorf("unified route charged %v, per-operation route %v", unified.policies, legacy.policies)
				}
			})
		}
	}
}

// The writes charge the authenticated write quota and the two reads charge none.
func TestSFUSignalChargesEachOperationItsOwnQuota(t *testing.T) {
	for _, operation := range signalCases {
		outcome := callSignal(t, signalPlane{}, signalRegistry{}, 1000, http.MethodPost, signalPath("signal"), operation.unified)
		var want []string
		if operation.name != "publications" && operation.name != "subscriptions" {
			want = []string{ratelimit.PolicyNameAuthenticatedWrite}
		}
		if strings.Join(outcome.policies, ",") != strings.Join(want, ",") {
			t.Errorf("%s charged %v, want %v", operation.name, outcome.policies, want)
		}
	}
}

func TestSFUSignalRefusesAnUnknownOperationOrField(t *testing.T) {
	for name, body := range map[string]string{
		"missing op":    `{}`,
		"unknown op":    `{"op":"teleport"}`,
		"unknown field": `{"op":"publications","extra":true}`,
	} {
		outcome := callSignal(t, signalPlane{}, signalRegistry{}, 1000, http.MethodPost, signalPath("signal"), body)
		if outcome.status != http.StatusBadRequest {
			t.Errorf("%s answered %d %s, want 400", name, outcome.status, outcome.body)
		}
	}
}

// The contract of the unified route has to admit every body the operations send and receive.
func TestSFUSignalContractAdmitsEveryOperationBody(t *testing.T) {
	strict := func(raw string, target any) error {
		decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
		decoder.DisallowUnknownFields()
		return decoder.Decode(target)
	}
	for _, operation := range signalCases {
		if err := strict(operation.unified, &sfuSignalRequest{}); err != nil {
			t.Errorf("%s request: %v", operation.name, err)
		}
		legacy := callSignal(t, signalPlane{}, signalRegistry{}, 1000, operation.method, signalPath(operation.suffix), operation.legacy)
		if err := strict(legacy.body, &sfuSignalResponse{}); err != nil {
			t.Errorf("%s response %s: %v", operation.name, legacy.body, err)
		}
	}
}

func mustSignalID(value string) utilities.ID {
	parsed, err := utilities.ParseID(value)
	if err != nil {
		panic(err)
	}
	return parsed
}

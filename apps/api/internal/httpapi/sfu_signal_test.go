package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type signalSpaces struct{ SpaceService }

func (signalSpaces) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}

type signalTenants struct{ TenantService }

func (signalTenants) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

type signalEpisodes struct{}

func (signalEpisodes) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}

type signalResolver struct{ service *mediaplane.Service }

func (r signalResolver) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	return r.service, nil
}

// signalPlane answers every signalling call with one canned result, or with err.
type signalPlane struct{ err error }

func (signalPlane) EnsureEpisode(context.Context, mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{}, nil
}
func (signalPlane) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	return mediaplane.Join{}, nil
}
func (signalPlane) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return nil
}
func (signalPlane) EndEpisode(context.Context, mediaplane.EndEpisodeInput) error { return nil }
func (signalPlane) EpisodeUsage(context.Context, mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	return mediaplane.Usage{}, nil
}
func (p signalPlane) AddTracks(_ context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	if p.err != nil {
		return mediaplane.TracksResponse{}, p.err
	}
	return mediaplane.TracksResponse{
		SessionDescription: &mediaplane.SessionDescription{SDP: "answer-sdp", Type: "answer"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: input.Tracks[0].Mid, TrackName: input.Tracks[0].TrackName}},
	}, nil
}
func (p signalPlane) Renegotiate(context.Context, mediaplane.RenegotiateRequest) error { return p.err }
func (p signalPlane) UpdateTracks(context.Context, mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	if p.err != nil {
		return mediaplane.TracksResponse{}, p.err
	}
	return mediaplane.TracksResponse{Tracks: []mediaplane.Track{{Location: "remote", Mid: "3", TrackName: "video", SessionID: "session-2"}}}, nil
}
func (p signalPlane) CloseTracks(context.Context, mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	if p.err != nil {
		return mediaplane.CloseTracksResponse{}, p.err
	}
	return mediaplane.CloseTracksResponse{SessionDescription: &mediaplane.SessionDescription{SDP: "answer-sdp", Type: "answer"}}, nil
}
func (p signalPlane) SubscriptionStates(context.Context, mediaplane.SubscriptionStatesRequest) ([]mediaplane.SubscriptionState, error) {
	if p.err != nil {
		return nil, p.err
	}
	return []mediaplane.SubscriptionState{{Mid: "3", SessionID: "session-2", TrackName: "video", State: mediaplane.SubscriptionActive, Revision: 4, EffectiveRID: "h"}}, nil
}

type signalRegistry struct{ err error }

func (r signalRegistry) RecordPublishedTracks(_ context.Context, input mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	if r.err != nil {
		return nil, r.err
	}
	return []mediapublications.PublishedReference{{Source: input.Tracks[0].Source, MID: input.Tracks[0].MID, TrackName: input.Tracks[0].TrackName, PublicationID: "publication-1"}}, nil
}
func (signalRegistry) RecordPublicationAvailability(context.Context, mediapublications.AvailabilityInput) error {
	return nil
}
func (r signalRegistry) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	return mediapublications.CloseDecision{ProviderCloseRequired: true}, r.err
}
func (r signalRegistry) RecordClosedPublication(context.Context, mediapublications.CloseInput) error {
	return r.err
}
func (r signalRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	if r.err != nil {
		return mediapublications.Snapshot{}, r.err
	}
	return mediapublications.Snapshot{Incarnation: 2, Sequence: 9, Publications: []provideroperations.Publication{{ParticipantID: signalSubject(nil).ParticipantID, Source: "camera", PublicationID: "publication-1", Enabled: true}}}, nil
}

// signalLimiter records each policy it is asked about and refuses once exhaustAfter calls have passed.
type signalLimiter struct {
	policies     []string
	exhaustAfter int
}

func (l *signalLimiter) Allow(_ context.Context, _ string, policy ratelimit.Policy, _ time.Time) ratelimit.Decision {
	l.policies = append(l.policies, policy.Name)
	if len(l.policies) > l.exhaustAfter {
		return ratelimit.Decision{State: ratelimit.Exhausted, RetryAfter: time.Second}
	}
	return ratelimit.Decision{State: ratelimit.Allowed, Remaining: 1}
}

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

type signalOrigins map[string]bool

func (o signalOrigins) AllowsOrigin(_ context.Context, _ utilities.ID, origin string) (bool, error) {
	return o[origin], nil
}

// One preflight covers a whole join for ten minutes, and the longer cache never
// lets in an origin the Tenant does not allow: a refused preflight sends no
// allow headers and no Max-Age, and the real request repeats the same check.
func TestTenantOriginPreflightCachesForTenMinutesAndStillRefusesOtherOrigins(t *testing.T) {
	handler := allowCORS(CORSOptions{TenantOrigins: signalOrigins{"https://customer.example": true}}, RateLimitOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	preflight := func(origin string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodOptions, signalPath("signal"), nil)
		request.Header.Set("Origin", origin)
		request.Header.Set("Access-Control-Request-Method", http.MethodPost)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	allowed := preflight("https://customer.example")
	if allowed.Code != http.StatusNoContent || allowed.Header().Get("Access-Control-Allow-Origin") != "https://customer.example" || allowed.Header().Get("Access-Control-Max-Age") != "600" {
		t.Errorf("allowed origin got %d, allow-origin %q, max-age %q; want 204, its origin, 600", allowed.Code, allowed.Header().Get("Access-Control-Allow-Origin"), allowed.Header().Get("Access-Control-Max-Age"))
	}
	refused := preflight("https://attacker.example")
	if refused.Code != http.StatusForbidden || refused.Header().Get("Access-Control-Allow-Origin") != "" || refused.Header().Get("Access-Control-Max-Age") != "" {
		t.Errorf("refused origin got %d, allow-origin %q, max-age %q; want 403 and neither header", refused.Code, refused.Header().Get("Access-Control-Allow-Origin"), refused.Header().Get("Access-Control-Max-Age"))
	}
}

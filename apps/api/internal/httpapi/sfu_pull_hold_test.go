package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// pullHoldPlane is a fake Cloudflare that lists the publisher track as active only after
// activeAfter session reads, and records every call in order.
type pullHoldPlane struct {
	addTracksRouteFixture
	mu          sync.Mutex
	calls       []string
	reads       int
	activeAfter int
}

func (p *pullHoldPlane) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, p)
	return &service, nil
}

func (p *pullHoldPlane) InspectSession(context.Context, string) (mediaplane.SessionState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reads++
	p.calls = append(p.calls, "get_session")
	return mediaplane.SessionState{Found: true, Tracks: []mediaplane.SessionTrack{{
		Location: "local", Mid: "camera-mid", TrackName: "camera-track", Active: p.reads > p.activeAfter,
	}}}, nil
}

func (p *pullHoldPlane) AddTracks(ctx context.Context, request mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	p.mu.Lock()
	p.calls = append(p.calls, "add_tracks")
	p.mu.Unlock()
	return p.addTracksRouteFixture.AddTracks(ctx, request)
}

func (p *pullHoldPlane) recordedCalls() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.calls...)
}

func TestAddTracksHoldsListenerPullUntilPublisherTrackIsActive(t *testing.T) {
	budget := 3 * time.Second
	for _, test := range []struct {
		name        string
		config      mediapublications.PullHoldConfig
		activeAfter int
		pulls       int
		wantCalls   []string
		minElapsed  time.Duration
		maxElapsed  time.Duration
	}{
		{
			name: "held until active, then forwarded", config: mediapublications.PullHoldConfig{Enabled: true, Budget: budget},
			activeAfter: 2, pulls: 1, wantCalls: []string{"get_session", "get_session", "get_session", "add_tracks"},
			minElapsed: 400 * time.Millisecond, maxElapsed: budget,
		},
		{
			name: "forwarded anyway after the budget", config: mediapublications.PullHoldConfig{Enabled: true, Budget: 450 * time.Millisecond},
			activeAfter: 1 << 30, pulls: 1, wantCalls: []string{"get_session", "get_session", "get_session", "add_tracks"},
			minElapsed: 450 * time.Millisecond, maxElapsed: budget,
		},
		{
			name: "an active track costs one read, then none", config: mediapublications.PullHoldConfig{Enabled: true, Budget: budget},
			pulls: 3, wantCalls: []string{"get_session", "add_tracks", "add_tracks", "add_tracks"}, maxElapsed: 100 * time.Millisecond,
		},
		{
			name: "flag off forwards without any session read", config: mediapublications.PullHoldConfig{},
			activeAfter: 1 << 30, pulls: 2, wantCalls: []string{"add_tracks", "add_tracks"}, maxElapsed: 100 * time.Millisecond,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			subject := participantMediaSubject(t)
			repository := &sfuLivenessRepository{participants: []mediapublications.PublicationParticipant{{
				ID: sfuLivenessTestID(t, "55555555-5555-4555-8555-555555555555"), Generation: 1, ConnectionID: "publisher-connection",
			}}}
			registry := mediapublications.NewService(repository).WithPullHold(test.config)
			if _, err := registry.RecordPublishedTracks(context.Background(), mediapublications.RecordInput{
				TenantID: subject.TenantID, EpisodeID: subject.EpisodeID,
				ParticipantID: sfuLivenessTestID(t, "55555555-5555-4555-8555-555555555555"), ParticipantGeneration: 1,
				ConnectionID: "publisher-connection",
				Tracks:       []mediapublications.PublishedTrack{{Source: "camera", MID: "camera-mid", TrackName: "camera-track"}},
			}); err != nil {
				t.Fatalf("record publication: %v", err)
			}
			plane := &pullHoldPlane{activeAfter: test.activeAfter}
			router := chi.NewRouter()
			router.Use(requireParticipantMedia(&participantMediaVerifierStub{subject: subject}, &activeParticipantAuthorizerStub{}))
			sfuAddTracksEndpoint(plane, plane, plane, plane, registry).Mount(router, RateLimitOptions{})
			path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/tracks", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID)

			started := time.Now()
			for pull := 0; pull < test.pulls; pull++ {
				request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"connection_id":"connection-123","tracks":[{"location":"remote","sessionId":"publisher-connection","trackName":"camera-track"}]}`))
				request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if response.Code != http.StatusOK {
					t.Fatalf("pull %d status=%d body=%s", pull, response.Code, response.Body.String())
				}
			}
			elapsed := time.Since(started)

			if got := plane.recordedCalls(); !reflect.DeepEqual(got, test.wantCalls) {
				t.Fatalf("Cloudflare calls=%v, want %v", got, test.wantCalls)
			}
			if elapsed < test.minElapsed || elapsed > test.maxElapsed {
				t.Fatalf("elapsed=%s, want between %s and %s", elapsed, test.minElapsed, test.maxElapsed)
			}
		})
	}
}

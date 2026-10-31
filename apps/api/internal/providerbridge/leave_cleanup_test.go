package providerbridge

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func TestOldParticipantCleanupDoesNotCloseReentryTrackOnSharedConnection(t *testing.T) {
	for _, effect := range []provideroperations.Effect{provideroperations.EffectRemoveParticipant, provideroperations.EffectRevokePublication} {
		t.Run(string(effect), func(t *testing.T) {
			ctx := context.Background()
			tenant := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
			episode := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
			old := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
			current := testExecutorID(t, "44444444-4444-4444-8444-444444444444")
			repository := &cleanupPublicationRepository{participants: []mediapublications.PublicationParticipant{{ID: old, Generation: 1, ConnectionID: "shared"}}}
			registry := mediapublications.NewService(repository)
			oldInput := mediapublications.RecordInput{TenantID: tenant, EpisodeID: episode, ParticipantID: old, ParticipantGeneration: 1, ConnectionID: "shared", Tracks: []mediapublications.PublishedTrack{{Source: "microphone", MID: "0", TrackName: "old"}}}
			if _, err := registry.RecordPublishedTracks(ctx, oldInput); err != nil {
				t.Fatal(err)
			}
			repository.participants = []mediapublications.PublicationParticipant{{ID: current, Generation: 2, ConnectionID: "shared"}}
			currentInput := mediapublications.RecordInput{TenantID: tenant, EpisodeID: episode, ParticipantID: current, ParticipantGeneration: 2, ConnectionID: "shared", Tracks: []mediapublications.PublishedTrack{{Source: "microphone", MID: "1", TrackName: "current"}}}
			if _, err := registry.RecordPublishedTracks(ctx, currentInput); err != nil {
				t.Fatal(err)
			}
			closer := &reentryTrackCloser{}
			operation := provideroperations.OperationInput{TenantID: tenant, EpisodeID: episode, ParticipantID: old, ParticipantGeneration: 1, PublicationSource: "microphone", Effect: effect}
			if result := NewSFUExecutor(registry, closer).Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeConfirmed {
				t.Fatalf("cleanup result: %+v", result)
			}
			if len(closer.requests) != 1 || closer.requests[0].ConnectionID != "shared" || len(closer.requests[0].Tracks) != 1 || closer.requests[0].Tracks[0].Mid != "0" {
				t.Fatalf("closed tracks: %+v", closer.requests)
			}
			snapshot, err := registry.Latest(ctx, tenant, episode)
			if err != nil {
				t.Fatal(err)
			}
			for _, publication := range snapshot.Publications {
				if publication.ParticipantID == current && publication.Enabled && publication.PublicationID != "" {
					return
				}
			}
			t.Fatalf("current publication missing: %+v", snapshot.Publications)
		})
	}
}

type reentryTrackCloser struct {
	requests []mediaplane.CloseTracksRequest
}

func (c *reentryTrackCloser) CloseTracks(_ context.Context, request mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	c.requests = append(c.requests, request)
	return mediaplane.CloseTracksResponse{}, nil
}

func TestLeaveCleanupPreservesRejoinedGeneration(t *testing.T) {
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"rejoined-connection","m":"0","t":"camera","g":2}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "camera", Enabled: true, PublicationID: publicationID}}
	closer := &executorTrackCloser{}
	executor := NewSFUExecutor(registry, closer)
	operation := provideroperations.OperationInput{ParticipantID: participantID, ParticipantGeneration: 1, Effect: provideroperations.EffectRemoveParticipant}
	if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeSatisfied {
		t.Fatalf("old cleanup outcome = %+v", result)
	}
	if closer.calls != 0 || registry.publication.PublicationID != publicationID || !registry.publication.Enabled {
		t.Fatalf("old cleanup changed rejoined publication: calls=%d publication=%+v", closer.calls, registry.publication)
	}
}

func TestLeaveCleanupCloudflare410IsSatisfiedAndReplayable(t *testing.T) {
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"departed-connection","m":"0","t":"camera","g":1}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "camera", Enabled: true, PublicationID: publicationID}}
	client := &goneCleanupClient{}
	adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, client, "https://example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	executor := NewSFUExecutor(registry, adapter)
	operation := provideroperations.OperationInput{ParticipantID: participantID, ParticipantGeneration: 1, Effect: provideroperations.EffectRemoveParticipant}
	for range 2 {
		if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeSatisfied {
			t.Fatalf("410 cleanup outcome = %+v", result)
		}
	}
	if client.calls != 1 || registry.publication.PublicationID != "" {
		t.Fatalf("410 cleanup did not converge: calls=%d publication=%+v", client.calls, registry.publication)
	}
}

type goneCleanupClient struct{ calls int }

func (c *goneCleanupClient) Do(*http.Request) (*http.Response, error) {
	c.calls++
	return &http.Response{StatusCode: http.StatusGone, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
}

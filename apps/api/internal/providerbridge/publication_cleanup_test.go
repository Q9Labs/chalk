package providerbridge

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type cleanupPublicationRepository struct {
	observations []provideroperations.Observation
	participants []mediapublications.PublicationParticipant
}

func (r *cleanupPublicationRepository) AppendObservation(_ context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	observation := provideroperations.Observation{TenantID: input.TenantID, EpisodeID: input.EpisodeID, Incarnation: input.Incarnation, Sequence: input.Sequence, Publications: input.Publications}
	r.observations = append(r.observations, observation)
	return observation, nil
}

func (r *cleanupPublicationRepository) ListObservations(context.Context, utilities.ID, utilities.ID, *provideroperations.Cursor, int) (provideroperations.ObservationPage, error) {
	return provideroperations.ObservationPage{Observations: r.observations}, nil
}

func (r *cleanupPublicationRepository) ListPublicationParticipants(context.Context, utilities.ID, utilities.ID) ([]mediapublications.PublicationParticipant, error) {
	return r.participants, nil
}

func TestPublicationRetirementPreservesProviderCleanup(t *testing.T) {
	for _, effect := range []provideroperations.Effect{provideroperations.EffectRemoveParticipant, provideroperations.EffectEndEpisode} {
		t.Run(string(effect), func(t *testing.T) {
			tenantID := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
			episodeID := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
			participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
			repository := &cleanupPublicationRepository{observations: []provideroperations.Observation{{TenantID: tenantID, EpisodeID: episodeID, Incarnation: 1, Sequence: 1, Publications: []provideroperations.Publication{{ParticipantID: participantID, Source: "camera", Enabled: true, PublicationID: "chalk_pub_v1.eyJjIjoicHVibGlzaGVyLWNvbm5lY3Rpb24iLCJtIjoiMCIsInQiOiJjYW1lcmEiLCJnIjoxfQ"}}}}}
			registry := mediapublications.NewService(repository)
			snapshot, err := registry.Latest(context.Background(), tenantID, episodeID)
			if err != nil || len(snapshot.Publications) != 1 || snapshot.Publications[0].Enabled {
				t.Fatalf("inactive participant still visible: snapshot=%+v err=%v", snapshot, err)
			}
			closer := &executorTrackCloser{}
			executor := NewSFUExecutor(registry, closer)
			operation := provideroperations.OperationInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, Effect: effect}
			if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeConfirmed || closer.calls != 1 {
				t.Fatalf("cleanup skipped provider track: result=%+v calls=%d", result, closer.calls)
			}
			if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeSatisfied || closer.calls != 1 {
				t.Fatalf("cleanup replay closed the track again: result=%+v calls=%d", result, closer.calls)
			}
		})
	}
}

func TestReplacementPublishingPreservesOtherSourcesForCleanup(t *testing.T) {
	for _, effect := range []provideroperations.Effect{provideroperations.EffectRemoveParticipant, provideroperations.EffectEndEpisode} {
		t.Run(string(effect), func(t *testing.T) {
			tenantID := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
			episodeID := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
			participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
			repository := &cleanupPublicationRepository{participants: []mediapublications.PublicationParticipant{{ID: participantID, Generation: 1, ConnectionID: "old"}}}
			registry := mediapublications.NewService(repository)
			input := mediapublications.RecordInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, ConnectionID: "old", Tracks: []mediapublications.PublishedTrack{{Source: "camera", MID: "0", TrackName: "camera"}, {Source: "screen", MID: "1", TrackName: "screen"}}}
			if _, err := registry.RecordPublishedTracks(context.Background(), input); err != nil {
				t.Fatal(err)
			}
			repository.participants[0].ConnectionID = "replacement"
			input.ConnectionID = "replacement"
			input.Tracks = []mediapublications.PublishedTrack{{Source: "microphone", MID: "0", TrackName: "microphone"}}
			if _, err := registry.RecordPublishedTracks(context.Background(), input); err != nil {
				t.Fatal(err)
			}
			closer := &cleanupSourceCloser{}
			executor := NewSFUExecutor(registry, closer)
			operation := provideroperations.OperationInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, Effect: effect}
			if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeConfirmed || closer.tracks != 3 {
				t.Fatalf("cleanup lost old sources: result=%+v tracks=%d", result, closer.tracks)
			}
			if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeSatisfied || closer.tracks != 3 {
				t.Fatalf("cleanup replay: result=%+v tracks=%d", result, closer.tracks)
			}
		})
	}
}

type cleanupSourceCloser struct{ tracks int }

func (c *cleanupSourceCloser) CloseTracks(_ context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	c.tracks += len(input.Tracks)
	return mediaplane.CloseTracksResponse{}, nil
}

func (r *cleanupPublicationRepository) AppendPublicationObservation(ctx context.Context, input provideroperations.ObservationInput, _ mediapublications.PublicationParticipant) (provideroperations.Observation, error) {
	return r.AppendObservation(ctx, input)
}

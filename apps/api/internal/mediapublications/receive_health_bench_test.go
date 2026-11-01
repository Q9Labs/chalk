package mediapublications

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type receiveHealthBenchmarkRepository struct {
	receiveHealthRepositoryStub
	delay time.Duration
	reads int
}

func (r *receiveHealthBenchmarkRepository) LatestObservation(context.Context, utilities.ID, utilities.ID) (provideroperations.Observation, error) {
	r.reads++
	if r.delay > 0 {
		time.Sleep(r.delay)
	}
	return r.observations[0], nil
}

func (r *receiveHealthBenchmarkRepository) ListPublicationParticipants(context.Context, utilities.ID, utilities.ID) ([]PublicationParticipant, error) {
	r.reads++
	if r.delay > 0 {
		time.Sleep(r.delay)
	}
	return r.participants, nil
}

func BenchmarkReceiveHealthObserveListenerPull(b *testing.B) {
	for _, delay := range []time.Duration{0, time.Millisecond} {
		b.Run(delay.String(), func(b *testing.B) {
			publisher := utilities.IDFromBytes([16]byte{1})
			listener := utilities.IDFromBytes([16]byte{2})
			episode := ReceiveHealthEpisode{TenantID: utilities.IDFromBytes([16]byte{3}), SpaceID: utilities.IDFromBytes([16]byte{4}), EpisodeID: utilities.IDFromBytes([16]byte{5})}
			repository := &receiveHealthBenchmarkRepository{delay: delay}
			repository.episodes = []ReceiveHealthEpisode{episode}
			repository.participants = []PublicationParticipant{{ID: publisher, Generation: 1, ConnectionID: "publisher"}, {ID: listener, Generation: 1, ConnectionID: "listener"}}
			repository.observations = []provideroperations.Observation{{Publications: []provideroperations.Publication{{
				ParticipantID: publisher, PublicationID: encodeReference("publisher", "0", "audio", 1), Source: "microphone", Enabled: true,
			}}}}
			service := newService(repository, time.Now)
			service.sampleReceiveHealth(context.Background())
			track := mediaplane.Track{Location: "remote", SessionID: "publisher", TrackName: "audio", Mid: "receiver"}
			input := ListenerPullInput{ReceiveHealthEpisode: episode, ParticipantID: listener, ParticipantGeneration: 1, ConnectionID: "listener",
				Requested: []mediaplane.Track{track}, Response: mediaplane.TracksResponse{Tracks: []mediaplane.Track{track}}}
			repository.reads = 0
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				service.ObserveListenerPull(context.Background(), input)
			}
			b.ReportMetric(float64(repository.reads)/float64(b.N), "reads/op")
		})
	}
}

package chalksfu_test

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// observationLog is the registry's storage for this test: every observation, in order.
type observationLog struct {
	observations []provideroperations.Observation
	participants []mediapublications.PublicationParticipant
}

func (l *observationLog) AppendPublicationObservation(ctx context.Context, input provideroperations.ObservationInput, _ mediapublications.PublicationParticipant) (provideroperations.Observation, error) {
	return l.AppendObservation(ctx, input)
}

func (l *observationLog) AppendObservation(_ context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	observation := provideroperations.Observation{TenantID: input.TenantID, EpisodeID: input.EpisodeID, Incarnation: input.Incarnation, Sequence: input.Sequence, Publications: input.Publications}
	l.observations = append(l.observations, observation)
	return observation, nil
}

func (l *observationLog) ListObservations(context.Context, utilities.ID, utilities.ID, *provideroperations.Cursor, int) (provideroperations.ObservationPage, error) {
	return provideroperations.ObservationPage{Observations: l.observations}, nil
}

func (l *observationLog) ListPublicationParticipants(context.Context, utilities.ID, utilities.ID) ([]mediapublications.PublicationParticipant, error) {
	return l.participants, nil
}

// A viewer that polls the registry's list while the publisher mutes and unmutes its microphone keeps one
// subscription: the SFU never sends it a second offer, it closes nothing, and the audio comes back on unmute.
func TestViewerThatPollsTheListKeepsItsSubscriptionThroughMuteAndUnmute(t *testing.T) {
	box := startSFU(t, nil)
	service := box.service(t)
	ctx := context.Background()
	alice, bob := scopeOf("ep-listed", "alice"), scopeOf("ep-listed", "bob")
	box.grant(t, alice)
	aliceConn, _ := join(t, service, alice)
	bobConn, _ := join(t, service, bob)

	tenantID, episodeID, aliceID := utilities.ID{}, utilities.ID{}, utilities.ID{}
	for _, id := range []*utilities.ID{&tenantID, &episodeID, &aliceID} {
		fresh, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		*id = fresh
	}
	log := &observationLog{participants: []mediapublications.PublicationParticipant{{ID: aliceID, Generation: 1, ConnectionID: aliceConn}}}
	registry := mediapublications.NewService(log)

	publisher := newPeer(t)
	audio := publisher.addAudio(t, "alice-mic")
	offer := publisher.offer(t)
	pushed, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: aliceConn, Scope: alice, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, audio), TrackName: "alice-mic", Source: "microphone"}},
	})
	if err != nil || len(pushed.Tracks) != 1 || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push = %+v, %v", pushed, err)
	}
	publisher.accept(t, pushed.SessionDescription)
	media, stop := context.WithCancel(ctx)
	defer stop()
	send(media, audio)
	aliceMid := publisher.mid(t, audio)
	references, err := registry.RecordPublishedTracks(ctx, mediapublications.RecordInput{
		TenantID: tenantID, EpisodeID: episodeID, ParticipantID: aliceID, ParticipantGeneration: 1, ConnectionID: aliceConn,
		Tracks: []mediapublications.PublishedTrack{{Source: "microphone", MID: aliceMid, TrackName: "alice-mic"}},
	})
	if err != nil || len(references) != 1 {
		t.Fatalf("record = %+v, %v", references, err)
	}

	// The viewer does what the SDK does on each poll: pull what is listed and not yet subscribed, close what is subscribed
	// and no longer listed.
	viewer := newPeer(t)
	subscribed := map[string]string{}
	offers, closes := 0, 0
	poll := func() {
		t.Helper()
		snapshot, err := registry.Latest(ctx, tenantID, episodeID)
		if err != nil {
			t.Fatal(err)
		}
		listed := map[string]bool{}
		for _, publication := range snapshot.Listed() {
			listed[publication.PublicationID] = true
			if _, have := subscribed[publication.PublicationID]; have {
				continue
			}
			reference, err := mediapublications.ParseReference(publication.PublicationID)
			if err != nil {
				t.Fatal(err)
			}
			pulled, err := service.AddTracks(ctx, mediaplane.TracksRequest{
				ConnectionID: bobConn, Scope: bob,
				Tracks: []mediaplane.Track{{Location: "remote", SessionID: reference.ConnectionID, TrackName: reference.TrackName}},
			})
			if err != nil || len(pulled.Tracks) != 1 || len(pulled.TrackErrors) != 0 {
				t.Fatalf("pull of %q = %+v, %v", publication.PublicationID, pulled, err)
			}
			if pulled.SessionDescription != nil {
				offers++
				if err := service.Renegotiate(ctx, mediaplane.RenegotiateRequest{ConnectionID: bobConn, Scope: bob, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
					t.Fatalf("answer: %v", err)
				}
			}
			subscribed[publication.PublicationID] = pulled.Tracks[0].Mid
		}
		for publicationID, mid := range subscribed {
			if listed[publicationID] {
				continue
			}
			closes++
			if _, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
				Provider: mediaplane.ProviderChalkSFU, ConnectionID: bobConn, Scope: bob,
				Tracks: []mediaplane.CloseTrack{{Mid: mid, Source: "microphone", PublicationID: publicationID}},
			}); err != nil {
				t.Fatalf("close: %v", err)
			}
			delete(subscribed, publicationID)
		}
	}
	mute := func(muted bool) {
		t.Helper()
		held, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{
			ConnectionID: aliceConn, Scope: alice,
			Tracks: []mediaplane.Track{{Location: "local", Mid: aliceMid, TrackName: "alice-mic", Source: "microphone", PublicationID: references[0].PublicationID, Paused: &muted}},
		})
		if err != nil || len(held.TrackErrors) != 0 {
			t.Fatalf("mute=%t: %+v, %v", muted, held, err)
		}
		if err := registry.RecordPublicationAvailability(ctx, mediapublications.AvailabilityInput{
			TenantID: tenantID, EpisodeID: episodeID, ParticipantID: aliceID, Source: "microphone", PublicationID: references[0].PublicationID, Enabled: !muted,
		}); err != nil {
			t.Fatalf("record mute=%t: %v", muted, err)
		}
	}

	poll()
	eventually(t, "the first audio to reach the viewer", 20*time.Second, func() bool { return viewer.received.Load() >= 20 })
	if offers != 1 {
		t.Fatalf("the first poll pulled with %d offers, want 1", offers)
	}

	for round := 1; round <= 2; round++ {
		mute(true)
		poll()
		time.Sleep(300 * time.Millisecond)
		quiet := viewer.received.Load()
		time.Sleep(300 * time.Millisecond)
		if delivered := viewer.received.Load() - quiet; delivered > 2 {
			t.Fatalf("round %d: a muted microphone still delivered %d packets", round, delivered)
		}

		mute(false)
		poll()
		resumed := viewer.received.Load()
		eventually(t, "the audio to come back after the unmute", 20*time.Second, func() bool { return viewer.received.Load() >= resumed+20 })
		if offers != 1 || closes != 0 {
			t.Fatalf("round %d: the viewer saw %d offers and closed %d tracks, want 1 and 0: a mute must not cost it its subscription", round, offers, closes)
		}
	}
}

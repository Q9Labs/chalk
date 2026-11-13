package chalksfu_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// everySpace is the staging allowlist: these tests run the own SFU for a Space without picking an ID.
var everySpace = func() spaces.ChalkSFUAllowlist {
	list, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		panic(err)
	}
	return list
}()

func scopeOf(episode, participant string) mediaplane.Scope {
	return mediaplane.Scope{TenantID: "tenant-1", EpisodeID: episode, ParticipantID: participant, Generation: 1}
}

func join(t *testing.T, service mediaplane.Service, scope mediaplane.Scope) (string, mediaplane.Join) {
	t.Helper()
	joined, err := service.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scope,
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID},
		ParticipantName: scope.ParticipantID, ExternalParticipantID: scope.ParticipantID, ParticipantPreset: "contributor",
	})
	if err != nil {
		t.Fatalf("join %s: %v", scope.ParticipantID, err)
	}
	connection, _ := joined.ClientPayload["connectionId"].(string)
	if connection == "" {
		t.Fatalf("join payload has no connection ID: %+v", joined.ClientPayload)
	}
	return connection, joined
}

// publish pushes one track from a fresh peer and returns the peer, its track and the SFU's answer.
func publish(t *testing.T, service mediaplane.Service, connection string, scope mediaplane.Scope, name string, source mediaplane.PublicationSource) (*peer, string, mediaplane.TracksResponse) {
	t.Helper()
	publisher := newPeer(t)
	track := publisher.addAudio(t, name)
	offer := publisher.offer(t)
	response, err := service.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: connection, Scope: scope, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, track), TrackName: name, Source: source}},
	})
	if err != nil {
		t.Fatalf("push %s: %v", name, err)
	}
	if len(response.TrackErrors) == 0 {
		publisher.accept(t, response.SessionDescription)
		media, stop := context.WithCancel(context.Background())
		t.Cleanup(stop)
		send(media, track)
	}
	return publisher, publisher.mid(t, track), response
}

func TestConformanceSignaling(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	service := box.service(t)
	ctx := context.Background()
	alice, bob := scopeOf("ep-signal", "alice"), scopeOf("ep-signal", "bob")
	box.grant(t, alice)

	aliceConn, joined := join(t, service, alice)
	capabilities, _ := joined.ClientPayload["capabilities"].(map[string]any)
	if joined.ClientPayload["provider"] != "chalk_sfu" || capabilities["serverLayerAdaptation"] != true || capabilities["subscriptionState"] != true || capabilities["iceRestart"] != true || capabilities["pullPublished"] != true || capabilities["muteInPlace"] != true || capabilities["keepsIdleSession"] != true {
		t.Fatalf("join payload advertises the wrong provider or capabilities: %+v", joined.ClientPayload)
	}
	bobConn, _ := join(t, service, bob)

	t.Run("resume returns the same connection and a gone one is not found", func(t *testing.T) {
		resumed, err := service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: alice, Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: alice.EpisodeID},
			ExternalParticipantID: "alice", ConnectionRef: aliceConn,
		})
		if err != nil || resumed.ClientPayload["connectionId"] != aliceConn {
			t.Fatalf("resume = %+v, %v", resumed, err)
		}
		_, err = service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: alice, Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: alice.EpisodeID},
			ExternalParticipantID: "alice", ConnectionRef: "no-such-session",
		})
		if !errors.Is(err, mediaplane.ErrConnectionNotFound) {
			t.Fatalf("resume of a gone session: %v", err)
		}
	})

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

	subscriber := newPeer(t)
	pulled, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: bobConn, Scope: bob,
		Tracks: []mediaplane.Track{
			{Location: "remote", SessionID: aliceConn, TrackName: "alice-mic"},
			{Location: "remote", SessionID: aliceConn, TrackName: "alice-missing"},
		},
	})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	t.Run("a pull mixes a success and an error", func(t *testing.T) {
		if len(pulled.Tracks) != 1 || pulled.Tracks[0].TrackName != "alice-mic" || pulled.Tracks[0].SessionID != aliceConn {
			t.Fatalf("pull = %+v", pulled)
		}
		// The error names the publisher's connection, which is what the client asked for,
		// and marks the publication missing so the API can retire it.
		if len(pulled.TrackErrors) != 1 || pulled.TrackErrors[0].TrackName != "alice-missing" || pulled.TrackErrors[0].Code != "track_not_found" || pulled.TrackErrors[0].ConnectionID != aliceConn || !pulled.TrackErrors[0].PublicationMissing {
			t.Fatalf("pull = %+v", pulled)
		}
		if !pulled.RequiresImmediateRenegotiation || pulled.SessionDescription == nil || pulled.SessionDescription.Type != "offer" {
			t.Fatalf("pull does not ask the client to answer: %+v", pulled)
		}
	})
	if err := service.Renegotiate(ctx, mediaplane.RenegotiateRequest{ConnectionID: bobConn, Scope: bob, SessionDescription: subscriber.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	eventually(t, "media to reach the subscriber", 20*time.Second, func() bool { return subscriber.received.Load() >= 20 })
	bobMid := pulled.Tracks[0].Mid

	t.Run("a layer update changes no SDP", func(t *testing.T) {
		updated, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{
			ConnectionID: bobConn, Scope: bob,
			Tracks: []mediaplane.Track{{Location: "remote", Mid: bobMid, TrackName: "alice-mic", SessionID: aliceConn, Simulcast: &mediaplane.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}}},
		})
		if err != nil || updated.RequiresImmediateRenegotiation || updated.SessionDescription != nil || len(updated.TrackErrors) != 0 {
			t.Fatalf("layer update = %+v, %v", updated, err)
		}
	})

	t.Run("a pause in place stops delivery, keeps the MID and reports its state", func(t *testing.T) {
		paused, resumed := true, false
		subscription := mediaplane.Track{Location: "remote", Mid: bobMid, TrackName: "alice-mic", SessionID: aliceConn}
		read := func() mediaplane.SubscriptionState {
			t.Helper()
			states, err := service.SubscriptionStates(ctx, mediaplane.SubscriptionStatesRequest{ConnectionID: bobConn, Scope: bob})
			if err != nil || len(states) != 1 || states[0].Mid != bobMid || states[0].SessionID != aliceConn || states[0].TrackName != "alice-mic" {
				t.Fatalf("subscription states = %+v, %v", states, err)
			}
			return states[0]
		}
		before := read()
		if before.State != mediaplane.SubscriptionActive || before.Reason != "" {
			t.Fatalf("flowing subscription = %+v", before)
		}
		subscription.Paused = &paused
		updated, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{ConnectionID: bobConn, Scope: bob, Tracks: []mediaplane.Track{subscription}})
		if err != nil || updated.RequiresImmediateRenegotiation || updated.SessionDescription != nil || len(updated.TrackErrors) != 0 {
			t.Fatalf("pause = %+v, %v", updated, err)
		}
		during := read()
		if during.State != mediaplane.SubscriptionPaused || during.Reason != mediaplane.PauseViewer || during.Revision <= before.Revision {
			t.Fatalf("paused subscription = %+v after %+v", during, before)
		}
		held := subscriber.received.Load()
		time.Sleep(300 * time.Millisecond)
		if delivered := subscriber.received.Load() - held; delivered > 2 {
			t.Fatalf("a paused subscription still delivered %d packets", delivered)
		}
		subscription.Paused = &resumed
		if _, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{ConnectionID: bobConn, Scope: bob, Tracks: []mediaplane.Track{subscription}}); err != nil {
			t.Fatalf("resume: %v", err)
		}
		if after := read(); after.State != mediaplane.SubscriptionActive || after.Revision <= during.Revision {
			t.Fatalf("resumed subscription = %+v", after)
		}
		eventually(t, "media to resume", 10*time.Second, func() bool { return subscriber.received.Load() >= held+20 })
	})

	t.Run("a hold of a publication the node does not hold is a track error with no SDP", func(t *testing.T) {
		paused := true
		held, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{
			ConnectionID: aliceConn, Scope: alice,
			Tracks: []mediaplane.Track{{Location: "local", Mid: "99", TrackName: "alice-mic", Source: "microphone", Paused: &paused}},
		})
		if err != nil || held.SessionDescription != nil || held.RequiresImmediateRenegotiation || len(held.TrackErrors) != 1 || held.TrackErrors[0].Code != "track_not_found" {
			t.Fatalf("hold of a missing publication = %+v, %v", held, err)
		}
	})

	t.Run("inspect sees own and peer sessions and a gone one as absent", func(t *testing.T) {
		own, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: alice})
		if err != nil || !own.Found || len(own.Tracks) != 1 || !own.Tracks[0].Active {
			t.Fatalf("own inspect = %+v, %v", own, err)
		}
		peerView, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: bob, Peer: true})
		if err != nil || !peerView.Found || len(peerView.Tracks) != 1 {
			t.Fatalf("peer inspect = %+v, %v", peerView, err)
		}
		absent, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: "no-such-session", Scope: alice})
		if err != nil || absent.Found {
			t.Fatalf("gone inspect = %+v, %v", absent, err)
		}
	})

	t.Run("receive-only close never stops a publication", func(t *testing.T) {
		closed, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: mediaplane.ProviderChalkSFU, ConnectionID: aliceConn, Scope: alice, ReceiveOnly: true,
			Tracks: []mediaplane.CloseTrack{{Mid: aliceMid, Source: "microphone", PublicationID: "pub-alice"}},
		})
		if err != nil || !closed.AlreadyClosed {
			t.Fatalf("receive-only close = %+v, %v", closed, err)
		}
		state, _ := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: alice})
		if len(state.Tracks) != 1 {
			t.Fatalf("the publication was stopped: %+v", state)
		}
	})

	t.Run("a negotiated close answers the client's offer", func(t *testing.T) {
		for _, transceiver := range subscriber.pc.GetTransceivers() {
			if err := transceiver.Stop(); err != nil {
				t.Fatal(err)
			}
		}
		closeOffer := subscriber.offer(t)
		closed, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: mediaplane.ProviderChalkSFU, ConnectionID: bobConn, Scope: bob,
			Tracks: []mediaplane.CloseTrack{{Mid: bobMid, Source: "microphone", PublicationID: "pub-bob"}}, SessionDescription: &closeOffer,
		})
		if err != nil || closed.SessionDescription == nil || closed.AlreadyClosed {
			t.Fatalf("negotiated close = %+v, %v", closed, err)
		}
		subscriber.accept(t, closed.SessionDescription)
	})

	t.Run("a forced close stops the publication and repeats safely", func(t *testing.T) {
		for attempt := 0; attempt < 2; attempt++ {
			if _, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
				Provider: mediaplane.ProviderChalkSFU, ConnectionID: aliceConn, Scope: alice, Force: true,
				Tracks: []mediaplane.CloseTrack{{Mid: aliceMid, Source: "microphone", PublicationID: "pub-alice"}},
			}); err != nil {
				t.Fatalf("forced close attempt %d: %v", attempt, err)
			}
		}
		state, _ := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: alice})
		if len(state.Tracks) != 0 {
			t.Fatalf("tracks after forced close: %+v", state.Tracks)
		}
	})

	t.Run("ending the Episode removes its sessions and usage stays empty", func(t *testing.T) {
		if err := service.EndEpisode(ctx, mediaplane.EndEpisodeInput{Provider: mediaplane.ProviderChalkSFU, TenantID: "tenant-1", EpisodeRef: "ep-signal"}); err != nil {
			t.Fatalf("end Episode: %v", err)
		}
		for _, connection := range []struct {
			id    string
			scope mediaplane.Scope
		}{{aliceConn, alice}, {bobConn, bob}} {
			state, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: connection.id, Scope: connection.scope})
			if err != nil || state.Found {
				t.Fatalf("session %s after the Episode ended: %+v, %v", connection.id, state, err)
			}
		}
		closed, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: mediaplane.ProviderChalkSFU, ConnectionID: aliceConn, Scope: alice, Force: true, Tracks: []mediaplane.CloseTrack{{Mid: aliceMid, Source: "microphone", PublicationID: "pub-alice"}},
		})
		if err != nil || !closed.AlreadyClosed {
			t.Fatalf("forced close of a gone session = %+v, %v", closed, err)
		}
		usage, err := service.EpisodeUsage(ctx, mediaplane.EpisodeUsageInput{Provider: mediaplane.ProviderChalkSFU, EpisodeRef: "ep-signal"})
		if err != nil || usage.ParticipantMinutes != 0 || usage.EgressBytes != 0 || usage.IngressBytes != 0 {
			t.Fatalf("usage = %+v, %v", usage, err)
		}
	})
}

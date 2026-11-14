package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// These scenarios replay the media-control model's counterexamples against the real
// service: real HTTP, real Pion peers and real RTP.

func scopeIn(episode, participant string, generation int64) protocol.Scope {
	return protocol.Scope{TenantID: "tenant-1", EpisodeID: episode, ParticipantID: participant, Generation: generation}
}

// microphone is one published audio track that sends known RTP until the test ends.
type microphone struct {
	conn  string
	scope protocol.Scope
	peer  *peer
	track *webrtc.TrackLocalStaticRTP
	name  string
	mid   string
	sent  atomic.Int64
}

// joinAndPublish creates the session and publishes one microphone on it.
func joinAndPublish(t *testing.T, svc *service, scope protocol.Scope, name string) *microphone {
	t.Helper()
	m := &microphone{conn: svc.createSession(t, op(), scope), scope: scope, peer: newPeer(t)}
	m.publish(t, svc, name)
	return m
}

// publish adds a microphone track on a new section and pushes it.
func (m *microphone) publish(t *testing.T, svc *service, name string) protocol.TracksResponse {
	t.Helper()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, name, m.scope.ParticipantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.peer.pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	offer, err := m.peer.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	description := m.peer.complete(t, offer)
	m.track, m.name, m.mid = track, name, m.peer.mid(t, track)
	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+m.conn+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: m.scope, SessionDescription: &description,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: m.mid, TrackName: name, Source: "microphone"}},
	}, &pushed)
	if len(pushed.TrackErrors) != 0 || pushed.SessionDescription == nil {
		t.Fatalf("push: %+v", pushed)
	}
	if err := m.peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	var done sync.WaitGroup
	sendLoop(ctx, track, 'a', 111, &m.sent, &done)
	t.Cleanup(func() { stop(); done.Wait() })
	return pushed
}

// listener is a session that pulls tracks and counts the audio it receives.
type listener struct {
	conn     string
	scope    protocol.Scope
	peer     *peer
	received *receiver
}

func join(t *testing.T, svc *service, scope protocol.Scope) *listener {
	t.Helper()
	l := &listener{conn: svc.createSession(t, op(), scope), scope: scope, peer: newPeer(t)}
	l.received = collect(l.peer)
	return l
}

// pull subscribes to the microphone and answers the node's offer.
func (l *listener) pull(t *testing.T, svc *service, m *microphone) {
	t.Helper()
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+l.conn+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: l.scope,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: m.conn, TrackName: m.name}},
	}, &pulled)
	if len(pulled.TrackErrors) != 0 || pulled.SessionDescription == nil {
		t.Fatalf("pull: %+v", pulled)
	}
	if err := l.peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := l.peer.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	description := l.peer.complete(t, answer)
	svc.mustCall(t, "/v1/sessions/"+l.conn+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: l.scope, SessionDescription: description}, nil)
	eventually(t, "the listener to connect", 10*time.Second, func() bool {
		return l.peer.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
}

func (l *listener) audio() int { return l.received.count(webrtc.RTPCodecTypeAudio) }

// hears waits until at least count more audio packets arrive.
func (l *listener) hears(t *testing.T, what string, count int) {
	t.Helper()
	from := l.audio()
	eventually(t, what, 10*time.Second, func() bool { return l.audio() >= from+count })
}

// silent asserts no audio arrives for a while. The microphone keeps sending, so a
// silent listener means the node stopped forwarding.
func (l *listener) silent(t *testing.T, what string) {
	t.Helper()
	time.Sleep(150 * time.Millisecond) // packets already in flight
	from := l.audio()
	time.Sleep(600 * time.Millisecond)
	if got := l.audio() - from; got != 0 {
		t.Fatalf("%s: %d audio packets arrived", what, got)
	}
}

func (s *service) control(t *testing.T, episode string, controls ...protocol.SourceControl) protocol.SourceControlResponse {
	t.Helper()
	var response protocol.SourceControlResponse
	s.mustCall(t, "/v1/episodes/sources", protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: episode, Controls: controls}, &response)
	if len(response.Results) != len(controls) {
		t.Fatalf("source control results: %+v", response)
	}
	return response
}

// renew keeps sending the grants until the test ends, as the API's renewal loop does from
// its last read of durable authorization. After a newer revoke these are stale renewals.
func (s *service) renew(t *testing.T, episode string, controls ...protocol.SourceControl) {
	t.Helper()
	body, err := json.Marshal(protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: episode, Controls: controls})
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	var done sync.WaitGroup
	done.Go(func() {
		ticker := time.NewTicker(testLease / 4)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if response, err := s.client.Post(s.baseURL+"/v1/episodes/sources", "application/json", bytes.NewReader(body)); err == nil {
				_ = response.Body.Close()
			}
		}
	})
	t.Cleanup(func() { stop(); done.Wait() })
}

func grant(participant string, revision int64) protocol.SourceControl {
	return protocol.SourceControl{ParticipantID: participant, Source: "microphone", Action: protocol.SourceGrant, Revision: revision}
}

func revoke(participant string, revision int64) protocol.SourceControl {
	return protocol.SourceControl{ParticipantID: participant, Source: "microphone", Action: protocol.SourceRevoke, Revision: revision}
}

const testLease = time.Second

func TestSourceFencing(t *testing.T) {
	svc := startService(t, newAuthority(t, "chalk test CA"), func(cfg *config.Config) {
		cfg.SourceLeaseTTL = testLease
	})

	t.Run("media waits for a grant and stops by the lease bound when renewals and the revoke are lost", func(t *testing.T) {
		episode := "episode-lease"
		alice := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
		bob := join(t, svc, scopeIn(episode, "bob", 1))
		bob.pull(t, svc, alice)
		bob.silent(t, "before Sync granted the microphone")

		if result := svc.control(t, episode, grant("alice", 1)).Results[0]; !result.Applied || result.LeaseMillis <= 0 {
			t.Fatalf("grant: %+v", result)
		}
		bob.hears(t, "audio after the grant", 20)
		// Renewals keep the source forwarding well past one lease.
		for deadline := time.Now().Add(3 * testLease); time.Now().Before(deadline); time.Sleep(testLease / 4) {
			svc.control(t, episode, grant("alice", 1))
		}
		bob.hears(t, "audio while the lease is renewed", 10)

		// The host stops the microphone, but neither the revoke nor any renewal reaches the node.
		stopped := time.Now()
		eventually(t, "the lease to lapse", 3*testLease, func() bool {
			from := bob.audio()
			time.Sleep(200 * time.Millisecond)
			return bob.audio() == from
		})
		if waited := time.Since(stopped); waited > testLease+time.Second {
			t.Fatalf("media ran %s past the last renewal, beyond the %s lease", waited, testLease)
		}
		bob.silent(t, "after the lease lapsed")
		if tracks := svc.inspect(t, alice.conn, alice.scope); len(tracks) != 1 {
			t.Fatalf("the lapsed publication should stay until a revoke or close: %+v", tracks)
		}
	})

	t.Run("inspection reports a lapsed lease while RTP still arrives", func(t *testing.T) {
		episode := "episode-inspect"
		alice := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
		bob := join(t, svc, scopeIn(episode, "bob", 1))
		bob.pull(t, svc, alice)
		published := func() protocol.InspectedTrack {
			tracks := svc.inspect(t, alice.conn, alice.scope)
			if len(tracks) != 1 || tracks[0].Location != protocol.LocationLocal {
				t.Fatalf("alice's tracks: %+v", tracks)
			}
			return tracks[0]
		}
		delivered := func() protocol.SubscriptionState {
			tracks := svc.inspect(t, bob.conn, bob.scope)
			if len(tracks) != 1 || tracks[0].Subscription == nil {
				t.Fatalf("bob's tracks: %+v", tracks)
			}
			return *tracks[0].Subscription
		}
		before := delivered()
		if before.State != protocol.SubscriptionPaused || before.Reason != protocol.PauseSourceUnauthorized || published().Active {
			t.Fatalf("before any grant: %+v, publication active %v", before, published().Active)
		}

		svc.control(t, episode, grant("alice", 1))
		bob.hears(t, "audio after the grant", 20)
		granted := delivered()
		if granted.State != protocol.SubscriptionActive || granted.Revision <= before.Revision || !published().Active {
			t.Fatalf("after the grant: %+v (was %+v), publication active %v", granted, before, published().Active)
		}
		svc.control(t, episode, grant("alice", 1))
		if renewed := delivered(); renewed.State != protocol.SubscriptionActive || renewed.Revision != granted.Revision {
			t.Fatalf("a renewal changed the delivery: %+v, was %+v", renewed, granted)
		}

		// The microphone keeps sending, but no renewal reaches the node.
		var lapsed protocol.SubscriptionState
		eventually(t, "inspection to report the lapse", 3*testLease, func() bool {
			lapsed = delivered()
			return lapsed.State == protocol.SubscriptionPaused
		})
		if lapsed.Reason != protocol.PauseSourceUnauthorized || lapsed.Revision <= granted.Revision || lapsed.EffectiveRID != "" || published().Active {
			t.Fatalf("after the lapse: %+v (was %+v), publication active %v", lapsed, granted, published().Active)
		}
		bob.silent(t, "while the lease is lapsed")

		svc.control(t, episode, grant("alice", 1))
		bob.hears(t, "audio after the renewal", 10)
		if resumed := delivered(); resumed.State != protocol.SubscriptionActive || resumed.Revision <= lapsed.Revision || !published().Active {
			t.Fatalf("after the renewal: %+v (was %+v), publication active %v", resumed, lapsed, published().Active)
		}
	})

	t.Run("a stale renewal or a delayed push after a revoke never resumes media", func(t *testing.T) {
		episode := "episode-stale"
		svc.control(t, episode, grant("alice", 2))
		svc.renew(t, episode, grant("alice", 2))
		alice := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
		bob := join(t, svc, scopeIn(episode, "bob", 1))
		bob.pull(t, svc, alice)
		bob.hears(t, "audio under the grant", 20)

		result := svc.control(t, episode, revoke("alice", 3)).Results[0]
		if !result.Applied || len(result.Closed) != 1 || result.Closed[0].Mid != alice.mid || result.Closed[0].SessionID != alice.conn {
			t.Fatalf("revoke: %+v", result)
		}
		bob.silent(t, "after the revoke")
		if tracks := svc.inspect(t, alice.conn, alice.scope); len(tracks) != 0 {
			t.Fatalf("the revoke left a publication: %+v", tracks)
		}

		if result := svc.control(t, episode, grant("alice", 2)).Results[0]; result.Applied || result.Revision != 3 {
			t.Fatalf("a stale renewal applied: %+v", result)
		}
		alice.publish(t, svc, "alice-mic-again") // the SDK's delayed enable
		bob.pull(t, svc, alice)
		bob.silent(t, "a push after the revoke")

		// Once the faults stop, a newer grant converges.
		svc.control(t, episode, grant("alice", 4))
		svc.renew(t, episode, grant("alice", 4))
		bob.hears(t, "audio after a newer grant", 20)
	})

	t.Run("an off with no track fences a later publication", func(t *testing.T) {
		episode := "episode-no-track"
		if result := svc.control(t, episode, revoke("dave", 5)).Results[0]; !result.Applied || len(result.Closed) != 0 {
			t.Fatalf("revoke without a track: %+v", result)
		}
		dave := joinAndPublish(t, svc, scopeIn(episode, "dave", 1), "dave-mic")
		bob := join(t, svc, scopeIn(episode, "bob", 1))
		bob.pull(t, svc, dave)
		if result := svc.control(t, episode, grant("dave", 4)).Results[0]; result.Applied {
			t.Fatalf("a delayed grant undid the off: %+v", result)
		}
		bob.silent(t, "a publication after an off with no track")
		svc.control(t, episode, grant("dave", 6))
		svc.renew(t, episode, grant("dave", 6))
		bob.hears(t, "audio after the user turned the microphone on again", 20)
	})

	t.Run("a newer host stop during a pending capture wins whichever arrives first", func(t *testing.T) {
		episode := "episode-pending"
		svc.control(t, episode, grant("erin", 6))
		erin := &microphone{scope: scopeIn(episode, "erin", 1), peer: newPeer(t)}
		erin.conn = svc.createSession(t, op(), erin.scope)
		var stop sync.WaitGroup
		var stopStatus int
		stop.Go(func() {
			stopStatus, _ = svc.call(t, "/v1/episodes/sources", protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: episode, Controls: []protocol.SourceControl{revoke("erin", 7)}}, nil)
		})
		erin.publish(t, svc, "erin-mic")
		stop.Wait()
		if stopStatus != http.StatusOK {
			t.Fatalf("host stop: status %d", stopStatus)
		}
		svc.control(t, episode, grant("erin", 6)) // the enable that preceded the stop, delivered late
		bob := join(t, svc, scopeIn(episode, "bob", 1))
		var pulled protocol.TracksResponse
		status, _ := svc.call(t, "/v1/sessions/"+bob.conn+"/tracks", protocol.TracksRequest{
			OperationID: op(), Scope: bob.scope,
			Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: erin.conn, TrackName: erin.name}},
		}, &pulled)
		if status != http.StatusOK {
			t.Fatalf("pull: status %d", status)
		}
		if len(pulled.TrackErrors) == 0 {
			// The push won the race, so the revoke left a muted publication or closed it after the pull.
			if err := bob.peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
				t.Fatal(err)
			}
			answer, _ := bob.peer.pc.CreateAnswer(nil)
			description := bob.peer.complete(t, answer)
			svc.mustCall(t, "/v1/sessions/"+bob.conn+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: bob.scope, SessionDescription: description}, nil)
		}
		bob.silent(t, "a capture the host stopped while it was pending")
	})

	t.Run("an old device's late close never stops the new device, and a host stop fences both", func(t *testing.T) {
		episode := "episode-devices"
		svc.control(t, episode, grant("alice", 1))
		svc.renew(t, episode, grant("alice", 1))
		phone := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
		bob := join(t, svc, scopeIn(episode, "bob", 1))
		bob.pull(t, svc, phone)
		bob.hears(t, "audio from the first device", 20)

		laptop := joinAndPublish(t, svc, scopeIn(episode, "alice", 2), "alice-mic")
		bob.pull(t, svc, laptop)
		bob.hears(t, "audio from the second device", 20)
		// The first device repays its off debt against its own allocation, which the second device replaced.
		status, code := svc.call(t, "/v1/sessions/"+phone.conn+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: phone.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: phone.mid}},
		}, nil)
		if status != http.StatusNotFound || code != protocol.CodeSessionGone {
			t.Fatalf("the old device's close: status %d code %q", status, code)
		}
		bob.hears(t, "the second device after the old device's close", 20)

		result := svc.control(t, episode, revoke("alice", 2)).Results[0]
		if !result.Applied || len(result.Closed) != 1 || result.Closed[0].SessionID != laptop.conn {
			t.Fatalf("host stop: %+v", result)
		}
		bob.silent(t, "after the host stop")
	})
}

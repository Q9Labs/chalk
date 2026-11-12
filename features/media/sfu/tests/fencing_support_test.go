package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

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

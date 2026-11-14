package media

import (
	"context"
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func episodeScope(episode, participant string) protocol.Scope {
	return protocol.Scope{TenantID: "tenant-1", EpisodeID: episode, ParticipantID: participant, Generation: 1}
}

func TestRetriedPushReturnsTheFirstResult(t *testing.T) {
	node := newTestNode(t, nil)
	session := node.newTestSession(t, testScope("alice", 1))
	peer := newTestPeer(t)
	peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
	request := protocol.TracksRequest{
		OperationID: "push-1", Scope: session.scope, SessionDescription: peer.offer(t), Tracks: localTracks("mic", peer.mids(), "microphone"),
	}

	first, err := session.AddTracks(context.Background(), request)
	if err != nil || len(first.Tracks) != 1 || len(first.TrackErrors) != 0 {
		t.Fatalf("first push: %+v, %v", first, err)
	}
	// Without replay the same names would come back as duplicate_track.
	second, err := session.AddTracks(context.Background(), request)
	if err != nil {
		t.Fatalf("retried push: %v", err)
	}
	if second.SessionDescription == nil || second.SessionDescription.SDP != first.SessionDescription.SDP || len(second.TrackErrors) != 0 {
		t.Fatalf("retried push differs from the first result: %+v", second)
	}

	changed := request
	changed.Tracks = localTracks("other", peer.mids(), "microphone")
	if _, err := session.AddTracks(context.Background(), changed); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("reused operation ID with another body: %v, want operation conflict", err)
	}
	request.OperationID = ""
	if _, err := session.AddTracks(context.Background(), request); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("missing operation ID: %v, want invalid request", err)
	}
}

func TestOnlyOneScreenShareRunsInAnEpisode(t *testing.T) {
	node := newTestNode(t, nil)
	alice := node.newTestSession(t, episodeScope("a", "alice"))
	bob := node.newTestSession(t, episodeScope("a", "bob"))
	other := node.newTestSession(t, episodeScope("b", "carol"))

	share := func(session *Session, name string) protocol.TracksResponse {
		t.Helper()
		peer := newTestPeer(t)
		peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
		response, err := session.AddTracks(context.Background(), protocol.TracksRequest{
			OperationID: op(), Scope: session.scope, SessionDescription: peer.offer(t), Tracks: localTracks(name, peer.mids(), "screen"),
		})
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	if response := share(alice, "alice-screen"); len(response.Tracks) != 1 {
		t.Fatalf("first screen share: %+v", response)
	}
	bobPeer := newTestPeer(t)
	bobShare := func(name string, section int) protocol.TracksResponse {
		t.Helper()
		offer := bobPeer.offer(t)
		response, err := bob.AddTracks(context.Background(), protocol.TracksRequest{
			OperationID: op(), Scope: bob.scope, SessionDescription: offer, Tracks: localTracks(name, bobPeer.mids()[section:section+1], "screen"),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := bobPeer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
			t.Fatal(err)
		}
		return response
	}
	bobPeer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
	refused := bobShare("bob-screen", 0)
	if len(refused.Tracks) != 0 || len(refused.TrackErrors) != 1 || refused.TrackErrors[0].Code != protocol.TrackCodeScreenShareActive {
		t.Fatalf("second screen share: %+v, want screen_share_active", refused)
	}
	if response := share(other, "carol-screen"); len(response.Tracks) != 1 {
		t.Fatalf("a screen share in another Episode: %+v", response)
	}

	alice.mu.Lock()
	var mid string
	for key := range alice.published {
		mid = key
	}
	alice.mu.Unlock()
	if _, err := alice.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(), Scope: alice.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: mid}}}); err != nil {
		t.Fatal(err)
	}
	// The refused section was stopped, so it can never carry media again.
	if response := bobShare("bob-screen-retry", 0); len(response.Tracks) != 0 || len(response.TrackErrors) != 1 || response.TrackErrors[0].Code != protocol.TrackCodeInvalid {
		t.Fatalf("a retry on the refused section: %+v, want invalid", response)
	}
	bobPeer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
	if response := bobShare("bob-screen-2", 1); len(response.Tracks) != 1 {
		t.Fatalf("screen share on a new section after the first stopped: %+v", response)
	}
}

func TestAPushThatRacesCloseNeverHoldsTheScreen(t *testing.T) {
	node := newTestNode(t, nil)
	alice := node.newTestSession(t, episodeScope("a", "alice"))
	bob := node.newTestSession(t, episodeScope("a", "bob"))
	share := func(session *Session, name string) (protocol.TracksResponse, error) {
		t.Helper()
		peer := newTestPeer(t)
		peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
		return session.push(context.Background(), protocol.TracksRequest{
			OperationID: op(), Scope: session.scope, SessionDescription: peer.offer(t), Tracks: localTracks(name, peer.mids(), "screen"),
		})
	}

	// Close marks the session closed and releases its publications while the push is past
	// readyForNegotiation, so the push reaches registration on a closed session.
	alice.mu.Lock()
	alice.closed = true
	alice.mu.Unlock()
	if _, err := share(alice, "alice-screen"); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("push on a closed session: %v, want ErrSessionGone", err)
	}
	response, err := share(bob, "bob-screen")
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Tracks) != 1 {
		t.Fatalf("screen share after the racing push: %+v, want it accepted", response)
	}
}

func TestUpdateTracksPausesAndResumesWithoutSimulcast(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publish(t, publisher, "mic", 1)
	viewer := newTestPeer(t)
	request := pullRequest(subscriber, publisher, "mic-0")
	request.OperationID = op()
	pulled, err := subscriber.AddTracks(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatal(err)
	}
	low := protocol.Track{Location: protocol.LocationRemote, Mid: pulled.Tracks[0].Mid, TrackName: "mic-0", SessionID: publisher.id, Simulcast: &protocol.Simulcast{PreferredRID: "l"}}
	if _, err := subscriber.UpdateTracks(context.Background(), protocol.UpdateTracksRequest{OperationID: op(), Scope: subscriber.scope, Tracks: []protocol.Track{low}}); err != nil {
		t.Fatal(err)
	}
	for _, paused := range []bool{true, false} {
		track := protocol.Track{Location: protocol.LocationRemote, Mid: pulled.Tracks[0].Mid, TrackName: "mic-0", SessionID: publisher.id, Paused: paused}
		response, err := subscriber.UpdateTracks(context.Background(), protocol.UpdateTracksRequest{OperationID: op(), Scope: subscriber.scope, Tracks: []protocol.Track{track}})
		if err != nil || len(response.Tracks) != 1 || len(response.TrackErrors) != 0 {
			t.Fatalf("paused=%v update: %+v %v", paused, response, err)
		}
		subscriber.mu.Lock()
		got := subscriber.subscribed[track.Mid].currentRequest()
		subscriber.mu.Unlock()
		if got.paused != paused || got.ceiling != "l" {
			t.Fatalf("paused=%v update left paused %v and ceiling %q, want ceiling l", paused, got.paused, got.ceiling)
		}
	}
}

func TestUpdateTracksRecordsTheCeilingWithoutSDP(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publish(t, publisher, "mic", 1)
	viewer := newTestPeer(t)
	pulled, err := subscriber.AddTracks(context.Background(), func() protocol.TracksRequest {
		request := pullRequest(subscriber, publisher, "mic-0")
		request.OperationID = op()
		return request
	}())
	if err != nil {
		t.Fatal(err)
	}
	if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatal(err)
	}

	known := protocol.Track{Location: protocol.LocationRemote, Mid: pulled.Tracks[0].Mid, TrackName: "mic-0", SessionID: publisher.id, Simulcast: &protocol.Simulcast{PreferredRID: "l", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}}
	unknown := known
	unknown.Mid = "99"
	response, err := subscriber.UpdateTracks(context.Background(), protocol.UpdateTracksRequest{OperationID: op(), Scope: subscriber.scope, Tracks: []protocol.Track{known, unknown}})
	if err != nil {
		t.Fatal(err)
	}
	if response.SessionDescription != nil || response.RequiresImmediateRenegotiation || len(response.Tracks) != 1 || len(response.TrackErrors) != 1 {
		t.Fatalf("update response: %+v", response)
	}
	if response.TrackErrors[0].Code != protocol.TrackCodeNotFound {
		t.Fatalf("unknown subscription code = %q", response.TrackErrors[0].Code)
	}
	subscriber.mu.Lock()
	ceiling := subscriber.subscribed[known.Mid].currentRequest().ceiling
	subscriber.mu.Unlock()
	if ceiling != "l" {
		t.Fatalf("ceiling = %q, want l", ceiling)
	}
	if len(subscriber.pc.GetTransceivers()) != 1 {
		t.Fatalf("an update must not create a section; transceivers = %d", len(subscriber.pc.GetTransceivers()))
	}
}

func TestNegotiatedCloseStopsTheSubscriptionAndAnswersTheOffer(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publish(t, publisher, "mic", 1)
	viewer := newTestPeer(t)
	request := pullRequest(subscriber, publisher, "mic-0")
	request.OperationID = op()
	pulled, err := subscriber.AddTracks(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatal(err)
	}

	for _, transceiver := range viewer.pc.GetTransceivers() {
		if err := transceiver.Stop(); err != nil {
			t.Fatal(err)
		}
	}
	mid := pulled.Tracks[0].Mid
	closed, err := subscriber.CloseTracks(context.Background(), protocol.CloseTracksRequest{
		OperationID: op(), Scope: subscriber.scope, Tracks: []protocol.CloseTrack{{Mid: mid}}, SessionDescription: viewer.offer(t),
	})
	if err != nil {
		t.Fatalf("negotiated close: %v", err)
	}
	if closed.SessionDescription == nil || closed.SessionDescription.Type != "answer" || len(closed.Tracks) != 1 || closed.Tracks[0].AlreadyClosed {
		t.Fatalf("negotiated close response: %+v", closed)
	}
	if err := viewer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: closed.SessionDescription.SDP}); err != nil {
		t.Fatalf("the client cannot apply the close answer: %v", err)
	}
	if state, err := subscriber.Inspect(); err != nil || len(state.Tracks) != 0 {
		t.Fatalf("inspect after close: %+v, %v", state, err)
	}
	// The publisher is untouched and the subscriber can pull again.
	if state, _ := publisher.Inspect(); len(state.Tracks) != 1 {
		t.Fatalf("publisher tracks = %+v", state.Tracks)
	}
}

func TestPeerSessionStaysInsideTheEpisode(t *testing.T) {
	node := newTestNode(t, nil)
	alice := node.newTestSession(t, episodeScope("a", "alice"))
	bob := node.newTestSession(t, episodeScope("a", "bob"))
	carol := node.newTestSession(t, episodeScope("b", "carol"))

	if found, err := node.PeerSession(alice.id, bob.scope); err != nil || found != alice {
		t.Fatalf("a peer in the same Episode: %v, %v", found, err)
	}
	if _, err := node.PeerSession(carol.id, bob.scope); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("a session of another Episode: %v, want gone", err)
	}
	other := bob.scope
	other.TenantID = "tenant-2"
	if _, err := node.PeerSession(alice.id, other); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("a session of another Tenant: %v, want gone", err)
	}
}

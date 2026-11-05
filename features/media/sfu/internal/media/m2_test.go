package media

import (
	"context"
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
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

func TestRetriedPullAndAnswerAreNotRepeated(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publish(t, publisher, "mic", 1)
	viewer := newTestPeer(t)

	pull := pullRequest(subscriber, publisher, "mic-0")
	pull.OperationID = "pull-1"
	first, err := subscriber.AddTracks(context.Background(), pull)
	if err != nil || len(first.Tracks) != 1 {
		t.Fatalf("pull: %+v, %v", first, err)
	}
	// The offer is still pending, so a repeated pull would be refused as busy.
	again, err := subscriber.AddTracks(context.Background(), pull)
	if err != nil || len(again.Tracks) != 1 || again.Tracks[0].Mid != first.Tracks[0].Mid {
		t.Fatalf("retried pull: %+v, %v", again, err)
	}

	answer := protocol.RenegotiateRequest{OperationID: "answer-1", Scope: subscriber.scope, SessionDescription: viewer.answer(t, first.SessionDescription)}
	if err := subscriber.Renegotiate(context.Background(), answer); err != nil {
		t.Fatal(err)
	}
	// With the offer answered, a repeat would fail with no pending offer.
	if err := subscriber.Renegotiate(context.Background(), answer); err != nil {
		t.Fatalf("retried answer: %v", err)
	}
	answer.OperationID = "answer-2"
	if err := subscriber.Renegotiate(context.Background(), answer); !errors.Is(err, ErrNoPendingOffer) {
		t.Fatalf("a new operation with no pending offer: %v", err)
	}
	if len(subscriber.subscribed) != 1 {
		t.Fatalf("subscriptions = %d, want 1", len(subscriber.subscribed))
	}
}

func TestReplayTableForgetsOnlyTheOldestRecord(t *testing.T) {
	var table replayTable
	for index := range maxOperationRecords + 1 {
		if err := table.remember(operationName(index), "body", index); err != nil {
			t.Fatal(err)
		}
	}
	if _, found, _ := table.lookup(operationName(0), "body"); found {
		t.Fatal("the oldest record should be forgotten once the table is full")
	}
	if _, found, _ := table.lookup(operationName(1), "body"); !found {
		t.Fatal("the second record must survive")
	}
}

func operationName(index int) string {
	return "operation-" + string(rune('a'+index%26)) + "-" + itoa(index)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for ; value > 0; value /= 10 {
		digits = string(rune('0'+value%10)) + digits
	}
	return digits
}

func TestEpisodeReservationFormula(t *testing.T) {
	cases := []struct{ participants, want int }{{0, 0}, {1, 1200}, {2, 1200}, {4, 4000}, {8, 14400}}
	for _, test := range cases {
		if got := episodeReservation(test.participants, 200); got != test.want {
			t.Errorf("episodeReservation(%d, 200) = %d, want %d", test.participants, got, test.want)
		}
	}
}

func TestJoinIsRefusedAtThePacketBudget(t *testing.T) {
	// 150 + 50 packets/s per stream: one two-person Episode reserves 1200, a third person 2400.
	node := newTestNode(t, func(cfg *config.Config) { cfg.PacketBudget = 3600 })
	node.newTestSession(t, episodeScope("a", "p1"))
	node.newTestSession(t, episodeScope("a", "p2"))
	third := node.newTestSession(t, episodeScope("a", "p3")) // 2400 reserved
	_ = third

	// A new Episode needs room for two: 2400 + 1200 = 3600 fits exactly.
	node.newTestSession(t, episodeScope("b", "p1"))
	if _, err := node.CreateSession("create-a-p4", episodeScope("a", "p4")); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("fourth Participant of Episode a: %v, want capacity exceeded", err)
	}
	if _, err := node.CreateSession("create-c-p1", episodeScope("c", "p1")); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("new Episode c: %v, want capacity exceeded", err)
	}
	budget, reserved := node.Budget()
	if budget != 3600 || reserved != 3600 {
		t.Fatalf("budget %d reserved %d, want 3600 and 3600", budget, reserved)
	}

	// A reconnect replaces its own session and does not count twice.
	reconnect := episodeScope("a", "p1")
	reconnect.Generation = 2
	if _, err := node.CreateSession("create-a-p1-g2", reconnect); err != nil {
		t.Fatalf("reconnect at the budget: %v", err)
	}

	// Leaving frees the reservation.
	node.EndEpisode("tenant-1", "b")
	if _, err := node.CreateSession("create-c-p1-again", episodeScope("c", "p1")); err != nil {
		t.Fatalf("new Episode after room opened: %v", err)
	}
}

func TestEpisodeCapStopsTheNinthParticipant(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.MaxSessions = 16; cfg.MaxEpisodeParticipants = 8 })
	for index := range 8 {
		node.newTestSession(t, episodeScope("a", "p"+itoa(index)))
	}
	if _, err := node.CreateSession("create-ninth", episodeScope("a", "p8")); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("ninth Participant: %v, want capacity exceeded", err)
	}
	if _, err := node.CreateSession("create-other-episode", episodeScope("b", "p0")); err != nil {
		t.Fatalf("another Episode: %v", err)
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
	refused := share(bob, "bob-screen")
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
	if response := share(bob, "bob-screen-2"); len(response.Tracks) != 1 {
		t.Fatalf("screen share after the first stopped: %+v", response)
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
	ceiling := subscriber.subscribed[known.Mid].ceiling.Load()
	subscriber.mu.Unlock()
	if ceiling == nil || *ceiling != "l" {
		t.Fatalf("ceiling = %v, want l", ceiling)
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

func TestReceiveOnlyCloseNeverStopsAPublication(t *testing.T) {
	node := newTestNode(t, nil)
	session := node.newTestSession(t, testScope("alice", 1))
	peer := publish(t, session, "mic", 1)

	response, err := session.CloseTracks(context.Background(), protocol.CloseTracksRequest{
		OperationID: op(), Scope: session.scope, Force: true, ReceiveOnly: true, Tracks: []protocol.CloseTrack{{Mid: peer.mids()[0]}},
	})
	if err != nil || len(response.Tracks) != 1 || !response.Tracks[0].AlreadyClosed {
		t.Fatalf("receive-only close of a publication: %+v, %v", response, err)
	}
	if state, _ := session.Inspect(); len(state.Tracks) != 1 {
		t.Fatalf("the publication was stopped: %+v", state.Tracks)
	}
}

func TestEndEpisodeClosesOnlyThatEpisode(t *testing.T) {
	node := newTestNode(t, nil)
	a := node.newTestSession(t, episodeScope("a", "p1"))
	node.newTestSession(t, episodeScope("a", "p2"))
	b := node.newTestSession(t, episodeScope("b", "p1"))

	if closed := node.EndEpisode("tenant-1", "a"); closed != 2 {
		t.Fatalf("closed %d sessions, want 2", closed)
	}
	if !a.isClosed() || b.isClosed() {
		t.Fatalf("a closed = %v, b closed = %v", a.isClosed(), b.isClosed())
	}
	if closed := node.EndEpisode("tenant-1", "a"); closed != 0 {
		t.Fatalf("a second end closed %d sessions", closed)
	}
	if closed := node.EndEpisode("tenant-2", "b"); closed != 0 {
		t.Fatal("another Tenant's end must not close Tenant 1's Episode")
	}
}

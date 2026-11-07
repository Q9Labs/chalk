package media

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func captureScope(episode, capture string, epoch int64) protocol.Scope {
	return protocol.Scope{TenantID: "tenant-1", EpisodeID: episode, ParticipantID: capture, Generation: epoch}
}

func (n *Node) newTestCapture(t *testing.T, scope protocol.Scope) *Session {
	t.Helper()
	response, err := n.CreateCaptureSession("capture-"+scope.EpisodeID+"-"+scope.ParticipantID+"-"+itoa(int(scope.Generation)), scope)
	if err != nil {
		t.Fatal(err)
	}
	session, err := n.Session(response.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func TestACaptureHoldsNoParticipantSlot(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.MaxEpisodeParticipants = 2 })
	node.newTestSession(t, episodeScope("a", "p1"))
	node.newTestSession(t, episodeScope("a", "p2"))
	node.newTestCapture(t, captureScope("a", "recording-1", 1))

	if _, err := node.CreateSession("create-a-p3", episodeScope("a", "p3")); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("third Participant: %v, want the Episode full at 2", err)
	}
	if _, reserved := node.Budget(); reserved != node.episodeReservation(2)+530 {
		t.Fatalf("reserved %d, want two Participants plus one capture (%d)", reserved, node.episodeReservation(2)+530)
	}
}

func TestACaptureNeedsAnEpisodeTheNodeHosts(t *testing.T) {
	node := newTestNode(t, nil)
	if _, err := node.CreateCaptureSession("capture-x", captureScope("ghost", "recording-1", 1)); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("capture of an unhosted Episode: %v, want session gone", err)
	}
	if node.SessionCount() != 0 {
		t.Fatal("a refused capture left a session")
	}
	// A capture alone does not host the Episode once its Participants leave.
	p := node.newTestSession(t, episodeScope("a", "p1"))
	node.newTestCapture(t, captureScope("a", "recording-1", 1))
	p.Close()
	if _, err := node.CreateCaptureSession("capture-late", captureScope("a", "recording-2", 1)); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("capture after the last Participant left: %v, want session gone", err)
	}
}

func TestACaptureReservesItsOwnPacketsAgainstTheNodeBudget(t *testing.T) {
	two := (&Node{cfg: config.Config{VideoStreamCost: 150, CameraUplinkCost: 150, CamerasPerParticipant: 1, AudioStreamCost: 50, ScreenStreamCost: 210, EpisodePacketCeiling: 1 << 20, PacketBudget: 1 << 20}}).episodeReservation(2)
	node := newTestNode(t, func(cfg *config.Config) { cfg.PacketBudget = two + 529 })
	node.newTestSession(t, episodeScope("a", "p1"))
	node.newTestSession(t, episodeScope("a", "p2"))
	if _, err := node.CreateCaptureSession("capture-full", captureScope("a", "recording-1", 1)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("capture one packet over the budget: %v, want capacity exceeded", err)
	}
	if refusals := node.Telemetry().Refusals; refusals[RefusedNodeFull] != 1 {
		t.Fatalf("refusals %v, want one node_full", refusals)
	}

	exact := newTestNode(t, func(cfg *config.Config) { cfg.PacketBudget = two + 530 })
	exact.newTestSession(t, episodeScope("a", "p1"))
	exact.newTestSession(t, episodeScope("a", "p2"))
	first := exact.newTestCapture(t, captureScope("a", "recording-1", 1))
	// A new epoch replaces the old capture and does not count twice.
	exact.newTestCapture(t, captureScope("a", "recording-1", 2))
	if !first.isClosed() {
		t.Fatal("the newer epoch left the older capture open")
	}
	// A Participant join sees the capture's reservation: no room to grow.
	if _, err := exact.CreateSession("create-a-p3", episodeScope("a", "p3")); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("join into a budget the capture holds: %v, want capacity exceeded", err)
	}
	exact.EndEpisode("tenant-1", "a")
	if _, reserved := exact.Budget(); reserved != 0 {
		t.Fatalf("reserved %d after the Episode ended, want 0", reserved)
	}
}

func TestACaptureEpochFencesAnOlderEpoch(t *testing.T) {
	node := newTestNode(t, nil)
	node.newTestSession(t, episodeScope("a", "p1"))
	node.newTestCapture(t, captureScope("a", "recording-1", 2)).Close()
	if _, err := node.CreateCaptureSession("capture-delayed", captureScope("a", "recording-1", 1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("older epoch after a newer one: %v, want stale generation", err)
	}
	// A Participant with the same ID has its own fence: the capture's epoch does not touch it.
	if _, err := node.CreateSession("create-same-name", episodeScope("a", "recording-1")); err != nil {
		t.Fatalf("Participant named like a capture: %v", err)
	}
}

func TestACaptureNamedLikeAParticipantNeverReplacesIt(t *testing.T) {
	node := newTestNode(t, nil)
	alice := node.newTestSession(t, episodeScope("a", "alice"))
	node.newTestCapture(t, captureScope("a", "alice", 1))
	if alice.isClosed() {
		t.Fatal("a capture named like a Participant replaced it")
	}
}

func TestAnEpisodeHoldsAtMostItsCaptureLimit(t *testing.T) {
	node := newTestNode(t, nil)
	node.newTestSession(t, episodeScope("a", "p1"))
	node.newTestCapture(t, captureScope("a", "recording-1", 1))
	node.newTestCapture(t, captureScope("a", "transcription-1", 1))
	if _, err := node.CreateCaptureSession("capture-three", captureScope("a", "recording-2", 1)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("third capture: %v, want capacity exceeded", err)
	}
	if refusals := node.Telemetry().Refusals; refusals[RefusedCaptureLimit] != 1 {
		t.Fatalf("refusals %v, want one capture_limit", refusals)
	}
	// The next epoch of a capture the Episode already holds is a replacement, so it fits.
	node.newTestCapture(t, captureScope("a", "recording-1", 2))
}

func TestACaptureCanBeTurnedOff(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.MaxCapturesPerEpisode = 0 })
	node.newTestSession(t, episodeScope("a", "p1"))
	if _, err := node.CreateCaptureSession("capture-off", captureScope("a", "recording-1", 1)); !errors.Is(err, ErrUnsupportedOperation) {
		t.Fatalf("capture on a node with captures off: %v, want unsupported operation", err)
	}
	if kinds := node.SessionKinds(); len(kinds) != 0 {
		t.Fatalf("session kinds %v, want none", kinds)
	}
	if kinds := newTestNode(t, nil).SessionKinds(); len(kinds) != 1 || kinds[0] != protocol.SessionKindCapture {
		t.Fatalf("session kinds %v, want capture", kinds)
	}
}

func TestACaptureOnlyPullsAndEndingTheEpisodeClosesIt(t *testing.T) {
	node := newTestNode(t, nil)
	node.newTestSession(t, episodeScope("a", "p1"))
	capture := node.newTestCapture(t, captureScope("a", "recording-1", 1))
	_, err := capture.AddTracks(context.Background(), protocol.TracksRequest{OperationID: "push-1", Scope: capture.scope,
		SessionDescription: &protocol.SessionDescription{Type: "offer", SDP: "v=0"},
		Tracks:             []protocol.Track{{Location: protocol.LocationLocal, Mid: "0", TrackName: "mic", Source: "microphone"}}})
	if !errors.Is(err, ErrUnsupportedOperation) {
		t.Fatalf("push on a capture: %v, want unsupported operation", err)
	}
	if closed := node.EndEpisode("tenant-1", "a"); closed != 2 || !capture.isClosed() {
		t.Fatalf("ended %d sessions, capture closed %v; want both sessions closed", closed, capture.isClosed())
	}
}

func TestACaptureCreateIsNotAParticipantCreate(t *testing.T) {
	node := newTestNode(t, nil)
	node.newTestSession(t, episodeScope("a", "p1"))
	if _, err := node.CreateSession("same-operation", episodeScope("a", "recording-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := node.CreateCaptureSession("same-operation", episodeScope("a", "recording-1")); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("one operation ID for both kinds: %v, want operation conflict", err)
	}
	first, err := node.CreateCaptureSession("capture-replay", episodeScope("a", "recording-9"))
	if err != nil {
		t.Fatal(err)
	}
	if again, err := node.CreateCaptureSession("capture-replay", episodeScope("a", "recording-9")); err != nil || again != first {
		t.Fatalf("replayed capture create: %+v %v, want %+v", again, err, first)
	}
}

func TestADrainingNodeKeepsCapturingAHostedEpisodeAndAdmitsNoNewOne(t *testing.T) {
	node := newTestNode(t, nil)
	node.newTestSession(t, episodeScope("a", "p1"))
	node.Drain()
	node.newTestCapture(t, captureScope("a", "recording-1", 1))
	if _, err := node.CreateCaptureSession("capture-new-episode", captureScope("b", "recording-1", 1)); err == nil {
		t.Fatal("a draining node took a capture for an Episode it does not host")
	}
}

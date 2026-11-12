package media

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The capture tests below drive real Pion peers through the node's session API. A capture bound
// of three Participants with two cameras and a microphone each is 1,950 packets/s, and one camera
// subscription costs 300.
const (
	captureBound  = 3 * (2*300 + 50)
	cameraStream  = 300
	captureBudget = threePerson + captureBound
)

// newCaptureNode is a node with session limits for a few publishers and a capture, and a
// negotiation timeout that outlasts the test, because the capture here never answers the server's offers.
func newCaptureNode(t *testing.T, configure ...func(*config.Config)) *reserveFixture {
	t.Helper()
	return newReserveNode(t, append([]func(*config.Config){func(cfg *config.Config) {
		cfg.NegotiationTimeout = time.Minute
		cfg.MaxPublishedPerSession = 4
		cfg.MaxSubscriptionsPerSession = 4
		cfg.MaxCaptureSubscriptions = 8
	}}, configure...)...)
}

func (f *reserveFixture) reserveWithCapture(t *testing.T, episode string, participants int) {
	t.Helper()
	request := reserveRequest(episode, participants)
	request.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatalf("reserve %s with a capture slot: %v", episode, err)
	}
}

// camera joins the Participant and publishes one camera track with a Pion peer that never
// connects. It returns the track a capture pulls.
func (f *reserveFixture) camera(t *testing.T, episode, participant string) protocol.Track {
	t.Helper()
	scope := protocol.Scope{TenantID: "tenant", EpisodeID: episode, ParticipantID: participant, Generation: 1}
	if _, err := f.node.ControlSources(protocol.SourceControlRequest{TenantID: "tenant", EpisodeID: episode, Controls: []protocol.SourceControl{
		{ParticipantID: participant, Source: "camera", Action: protocol.SourceGrant, Revision: 1},
	}}); err != nil {
		t.Fatalf("grant %s a camera: %v", participant, err)
	}
	created, err := f.node.Create("join-"+episode+"-"+participant, scope, ParticipantSession, nil)
	if err != nil {
		t.Fatalf("join %s: %v", participant, err)
	}
	session, err := f.node.Session(created.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	video, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", participant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTrack(video); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	name := participant + "-cam"
	pushed, err := session.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID:        fmt.Sprintf("push-%d", reserves.Add(1)),
		Scope:              scope,
		SessionDescription: &protocol.SessionDescription{Type: "offer", SDP: offer.SDP},
		Tracks:             []protocol.Track{{Location: protocol.LocationLocal, Mid: pc.GetTransceivers()[0].Mid(), TrackName: name, Source: "camera"}},
	})
	if err != nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("%s publishes a camera: %v %+v", participant, err, pushed.TrackErrors)
	}
	return protocol.Track{Location: protocol.LocationRemote, SessionID: created.ConnectionID, TrackName: name}
}

// recorder is a capture session of an Episode.
type recorder struct {
	session *Session
	scope   protocol.Scope
}

func (f *reserveFixture) recorder(t *testing.T, episode string) recorder {
	t.Helper()
	scope := protocol.Scope{TenantID: "tenant", EpisodeID: episode, ParticipantID: "recorder", Generation: 1}
	created, err := f.node.Create("capture-"+episode, scope, CaptureSession, nil)
	if err != nil {
		t.Fatalf("create the capture session: %v", err)
	}
	session, err := f.node.Session(created.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	return recorder{session: session, scope: scope}
}

// pull subscribes the capture to the tracks in one request and returns their MIDs in order.
func (r recorder) pull(t *testing.T, tracks ...protocol.Track) []string {
	t.Helper()
	pulled, err := r.session.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: fmt.Sprintf("pull-%d", reserves.Add(1)), Scope: r.scope, Tracks: tracks,
	})
	if err != nil || len(pulled.TrackErrors) != 0 || len(pulled.Tracks) != len(tracks) {
		t.Fatalf("capture pulls %d tracks: %v %+v", len(tracks), err, pulled)
	}
	mids := make([]string, len(pulled.Tracks))
	for i, track := range pulled.Tracks {
		mids[i] = track.Mid
	}
	return mids
}

// stop ends the capture's subscription to the MID.
func (r recorder) stop(t *testing.T, mid string) {
	t.Helper()
	closed, err := r.session.CloseTracks(context.Background(), protocol.CloseTracksRequest{
		OperationID: fmt.Sprintf("stop-%d", reserves.Add(1)), Scope: r.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: mid}},
	})
	if err != nil || len(closed.Tracks) != 1 || closed.Tracks[0].AlreadyClosed {
		t.Fatalf("stop the subscription %s: %v %+v", mid, err, closed)
	}
}

// A subscription that ends after its Episode was re-reserved returns its share to the new hold,
// so the Episode is still promised its whole capture bound and no other Episode can take it.
func TestASubscriptionEndingAfterAReReserveReturnsItsShareToTheNewHold(t *testing.T) {
	f := newCaptureNode(t, func(cfg *config.Config) { cfg.PacketBudget = captureBudget })
	f.reserveWithCapture(t, "one", 3)
	alice := f.camera(t, "one", "alice")
	capture := f.recorder(t, "one")
	mid := capture.pull(t, alice)[0]
	f.reserveWithCapture(t, "one", 3)
	capture.stop(t, mid)
	if f.reserved() != captureBudget {
		t.Fatalf("after the subscription ended the node reserves %d, want %d", f.reserved(), captureBudget)
	}
	if _, err := f.node.Create("other", protocol.Scope{TenantID: "tenant", EpisodeID: "other", ParticipantID: "a", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("another Episode took the capture room the hold promised: %v", err)
	}
}

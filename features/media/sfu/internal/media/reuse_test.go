package media

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// These tests pull and close tracks on real Pion peers and read the offers the node makes. They
// prove the section rules of reuse: what an offer says about a free section and a reused one,
// and that the sections of a session follow its live tracks and not the pulls it ever made.

// offerSections is one media section of an SDP as the client reads it.
type offerSections struct {
	direction string
	port      int
	ssrcs     []string
}

func readSections(t *testing.T, raw string) map[string]offerSections {
	t.Helper()
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	sections := map[string]offerSections{}
	for _, media := range description.MediaDescriptions {
		mid, _ := media.Attribute(sdp.AttrKeyMID)
		section := offerSections{direction: "sendrecv", port: media.MediaName.Port.Value}
		for _, attribute := range media.Attributes {
			switch attribute.Key {
			case sdp.AttrKeySendOnly, sdp.AttrKeyRecvOnly, sdp.AttrKeyInactive, sdp.AttrKeySendRecv:
				section.direction = attribute.Key
			case "ssrc":
				ssrc, _, _ := cutSpace(attribute.Value)
				if len(section.ssrcs) == 0 || section.ssrcs[len(section.ssrcs)-1] != ssrc {
					section.ssrcs = append(section.ssrcs, ssrc)
				}
			}
		}
		sections[mid] = section
	}
	return sections
}

func cutSpace(value string) (string, string, bool) {
	for index := range len(value) {
		if value[index] == ' ' {
			return value[:index], value[index+1:], true
		}
	}
	return value, "", false
}

// publishMedia pushes one microphone ("mic") and one camera ("cam") from a new session.
func publishMedia(t *testing.T, s *Session) {
	t.Helper()
	peer := newTestPeer(t)
	peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
	peer.sendOnly(t, webrtc.RTPCodecTypeVideo, 1)
	offer := peer.offer(t)
	mids := peer.mids()
	response, err := s.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(), Scope: s.scope, SessionDescription: offer,
		Tracks: []protocol.Track{
			{Location: protocol.LocationLocal, Mid: mids[0], TrackName: "mic", Source: "microphone"},
			{Location: protocol.LocationLocal, Mid: mids[1], TrackName: "cam", Source: "camera"},
		}})
	if err != nil || len(response.TrackErrors) != 0 || len(response.Tracks) != 2 {
		t.Fatalf("publish: %+v, %v", response, err)
	}
}

// pullAndAnswer pulls one of the publisher's tracks, has the viewer answer the offer, and
// returns the offer's sections with the mid the response names.
func pullAndAnswer(t *testing.T, subscriber, publisher *Session, viewer *testPeer, name string) (string, map[string]offerSections) {
	t.Helper()
	pulled, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, name))
	if err != nil || len(pulled.Tracks) != 1 || len(pulled.TrackErrors) != 0 || pulled.SessionDescription == nil {
		t.Fatalf("pull %s: %+v, %v", name, pulled, err)
	}
	sections := readSections(t, pulled.SessionDescription.SDP)
	answer := viewer.answer(t, pulled.SessionDescription)
	if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: answer}); err != nil {
		t.Fatalf("answer %s: %v", name, err)
	}
	return pulled.Tracks[0].Mid, sections
}

func forceClose(t *testing.T, s *Session, mid string) {
	t.Helper()
	if _, err := s.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(), Scope: s.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: mid}}}); err != nil {
		t.Fatalf("close mid %s: %v", mid, err)
	}
}

func TestSectionsFollowLiveTracksNotPulls(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)

	const pulls = 100
	firstSize := 0
	seen := map[string]bool{}
	for pull := range pulls {
		name := []string{"mic", "cam", "mic", "mic", "cam", "cam"}[pull%6]
		mid, sections := pullAndAnswer(t, subscriber, publisher, viewer, name)
		seen[mid] = true
		if got := len(subscriber.pc.GetTransceivers()); got > 2 {
			t.Fatalf("pull %d: the node holds %d sections for at most one live track of each kind, want at most 2", pull, got)
		}
		if got := len(viewer.pc.GetTransceivers()); got > 2 {
			t.Fatalf("pull %d: the client holds %d sections, want at most 2", pull, got)
		}
		if section := sections[mid]; section.direction != "sendonly" || section.port == 0 || len(section.ssrcs) == 0 {
			t.Fatalf("pull %d: the section %s of the response is %+v, want an active sendonly section with a source", pull, mid, section)
		}
		for other, section := range sections {
			if other != mid && section.direction != "inactive" {
				t.Fatalf("pull %d: section %s is %s while its track is closed, want inactive", pull, other, section.direction)
			}
		}
		clientOffer, err := viewer.pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		if size := len(clientOffer.SDP); firstSize == 0 {
			firstSize = size
		} else if size > firstSize*2 {
			t.Fatalf("pull %d: the client offer is %d bytes after %d bytes at the first pull; it follows the pulls", pull, size, firstSize)
		}
		forceClose(t, subscriber, mid)
	}
	if len(seen) > 2 {
		t.Fatalf("%d pulls used %d mids, want 2 (one audio, one video)", pulls, len(seen))
	}
	t.Logf("%d pulls of two kinds used mids %v; the client offer stayed near %d bytes", pulls, fmt.Sprint(seen), firstSize)
}

// pullBoth has the viewer pull the mic and then the camera, so mids 0 and 1 are live.
func pullBoth(t *testing.T, subscriber, publisher *Session, viewer *testPeer) (mic, cam string) {
	t.Helper()
	mic, _ = pullAndAnswer(t, subscriber, publisher, viewer, "mic")
	cam, _ = pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	return mic, cam
}

// The SDK revives a parked section only when it is inactive on the client, active in the offer
// and named by the response of the request that produced the offer. These tests check that the
// node's offers and responses give it exactly that, and nothing else it would revive.
func TestReusedMidIsAnnouncedAsTheSDKRevives(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)

	mic, cam := pullBoth(t, subscriber, publisher, viewer)
	if mic == cam {
		t.Fatalf("mic and camera share mid %s", mic)
	}
	firstSources := map[string][]string{}
	{
		// The sources of the live sections, from an offer the node makes for a third pull of nothing new.
		offer, err := subscriber.pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		for mid, section := range readSections(t, offer.SDP) {
			firstSources[mid] = section.ssrcs
		}
	}

	forceClose(t, subscriber, mic)
	mid, sections := pullAndAnswer(t, subscriber, publisher, viewer, "mic")
	if mid != mic {
		t.Fatalf("the pull after the close got mid %s, want the closed mic mid %s", mid, mic)
	}
	if got := sections[mic]; got.direction != "sendonly" || got.port == 0 {
		t.Fatalf("reused section %s is %+v, want sendonly and not rejected", mic, got)
	}
	if got, old := sections[mic].ssrcs, firstSources[mic]; len(got) == 0 || len(old) == 0 || got[0] != old[0] {
		t.Fatalf("reused section has sources %v after %v: the section keeps its SSRC, so the transport holds no new crypto state", got, old)
	}
	if got := sections[cam]; got.direction != "sendonly" || len(got.ssrcs) == 0 || got.ssrcs[0] != firstSources[cam][0] {
		t.Fatalf("the live camera section changed with the mic pull: %+v, was %v", got, firstSources[cam])
	}

	// Both tracks closed: the camera pull reuses the camera mid, and the mic mid stays inactive and unnamed.
	forceClose(t, subscriber, mic)
	forceClose(t, subscriber, cam)
	mid, sections = pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	if mid != cam {
		t.Fatalf("camera pull got mid %s, want %s", mid, cam)
	}
	if got := sections[cam]; got.direction != "sendonly" {
		t.Fatalf("reused camera section is %s, want sendonly", got.direction)
	}
	if got := sections[mic]; got.direction != "inactive" || len(got.ssrcs) != 0 {
		t.Fatalf("the unnamed free mic section is %+v, want inactive with no source", got)
	}
}

func TestANegotiatedCloseFreesTheMidAndARejectedSectionIsNeverReused(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)
	mic, _ := pullBoth(t, subscriber, publisher, viewer)

	closeNegotiated := func(mid string, reject bool) {
		t.Helper()
		for _, transceiver := range viewer.pc.GetTransceivers() {
			if transceiver.Mid() == mid {
				if err := transceiver.Stop(); err != nil {
					t.Fatal(err)
				}
			}
		}
		offer := viewer.offer(t)
		if reject {
			offer.SDP = rejectSection(t, offer.SDP, mid)
		}
		closed, err := subscriber.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: offer, Tracks: []protocol.CloseTrack{{Mid: mid}}})
		if err != nil || len(closed.Tracks) != 1 || closed.Tracks[0].AlreadyClosed {
			t.Fatalf("negotiated close of %s: %+v, %v", mid, closed, err)
		}
		if err := viewer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: closed.SessionDescription.SDP}); err != nil {
			t.Fatal(err)
		}
	}

	closeNegotiated(mic, false)
	if mid, _ := pullAndAnswer(t, subscriber, publisher, viewer, "mic"); mid != mic {
		t.Fatalf("after a negotiated close that parked the section the pull got mid %s, want %s", mid, mic)
	}

	// An older client stops the transceiver, so its offer rejects the section (port 0). A browser
	// treats that section as gone for good, so the node must add a new one.
	closeNegotiated(mic, true)
	mid, sections := pullAndAnswer(t, subscriber, publisher, viewer, "mic")
	if mid == mic {
		t.Fatalf("the pull reused mid %s, which the client rejected", mic)
	}
	if got := sections[mic]; got.port != 0 && got.direction != "inactive" {
		t.Fatalf("rejected section is %+v in the next offer, want it left inactive or rejected", got)
	}
}

// boundPayloadType is the payload type a subscription's sender writes, from its egress binding.
func boundPayloadType(t *testing.T, s *Session, mid string) uint8 {
	t.Helper()
	s.mu.Lock()
	subscription := s.subscribed[mid]
	s.mu.Unlock()
	if subscription == nil {
		t.Fatalf("no subscription on mid %s", mid)
	}
	binding := subscription.track.binding.Load()
	if binding == nil {
		t.Fatalf("mid %s has no negotiated binding", mid)
	}
	return binding.payloadType
}

// A client that offers VP8 on its own payload type fixes what the node sends to it. A reused
// section must send on that payload type and not on the node's default.
func TestReusedSectionSendsTheNegotiatedPayloadType(t *testing.T) {
	const clientPayloadType = 120
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t, webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, PayloadType: clientPayloadType})
	viewer.sendOnly(t, webrtc.RTPCodecTypeVideo, 1)
	offer := viewer.offer(t)
	own, err := subscriber.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: offer,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: viewer.mids()[0], TrackName: "own", Source: "camera"}}})
	if err != nil || own.SessionDescription == nil {
		t.Fatalf("publish: %+v, %v", own, err)
	}
	if err := viewer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: own.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}

	mid, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	if got := boundPayloadType(t, subscriber, mid); got != clientPayloadType {
		t.Fatalf("first pull sends on payload type %d, want the negotiated %d", got, clientPayloadType)
	}
	forceClose(t, subscriber, mid)
	reused, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	if reused != mid {
		t.Fatalf("the second pull got mid %s, want the reused %s", reused, mid)
	}
	if got := boundPayloadType(t, subscriber, reused); got != clientPayloadType {
		t.Fatalf("the reused section sends on payload type %d, want the negotiated %d", got, clientPayloadType)
	}
}

// rejectSection sets the port of one section to 0, as a browser's offer does for a stopped transceiver.
func rejectSection(t *testing.T, raw, mid string) string {
	t.Helper()
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	for _, media := range description.MediaDescriptions {
		if got, _ := media.Attribute(sdp.AttrKeyMID); got == mid {
			media.MediaName.Port.Value = 0
		}
	}
	out, err := description.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// An unanswered server offer closes the session even when the timer fires as the pull returns.
// Run with -race: the timer's closure must see the pending offer fully built.
func TestAnUnansweredOfferClosesTheSessionWhenItsTimerFiresAtOnce(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.NegotiationTimeout = time.Millisecond })
	publisher := node.newTestSession(t, testScope("alice", 1))
	publishMedia(t, publisher)
	for index := range 20 {
		subscriber := node.newTestSession(t, testScope(fmt.Sprintf("bob-%d", index), 1))
		if _, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, "mic")); err != nil && !errors.Is(err, ErrSessionGone) {
			t.Fatalf("pull %d: %v", index, err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for !subscriber.isClosed() {
			if time.Now().After(deadline) {
				t.Fatalf("session %d stayed open after its server offer went unanswered", index)
			}
			time.Sleep(time.Millisecond)
		}
	}
}

// Quiet reuse cycles must not move a section's RTX sequence. The transport derives the SRTP index of
// an SSRC from the packets it encrypts, so a sequence that skipped ahead on every park would wrap
// back onto numbers already used at the same index.
func TestQuietReuseCyclesKeepTheRepairSequence(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)

	bindingOf := func(mid string) (*egressTrack, *egressBinding) {
		subscriber.mu.Lock()
		defer subscriber.mu.Unlock()
		track := subscriber.subscribed[mid].track
		return track, track.binding.Load()
	}
	mid, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	_, binding := bindingOf(mid)
	if binding == nil || binding.rtxSSRC == 0 {
		t.Fatalf("the camera binding %+v has no RTX stream", binding)
	}
	binding.rtxSeq.Store(64) // 64 repairs were sent
	forceClose(t, subscriber, mid)

	var track *egressTrack
	for cycle := range 20 {
		again, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
		if again != mid {
			t.Fatalf("cycle %d: the camera got mid %s, want %s", cycle, again, mid)
		}
		track, _ = bindingOf(mid)
		forceClose(t, subscriber, mid)
	}
	if want := uint32(64 + rtxSeqMargin); track.rtxSeqFrom != want {
		t.Fatalf("after 20 quiet cycles the repair sequence starts at %d, want %d: it moved without a packet", track.rtxSeqFrom, want)
	}
}

// A pull that took a parked section while the session closed must not leave the section's sender on
// the closed connection.
func TestAttachingAParkedSectionToAClosedSessionFails(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)
	mid, _ := pullAndAnswer(t, subscriber, publisher, viewer, "mic")
	forceClose(t, subscriber, mid)
	parked := subscriber.freeSection(webrtc.RTPCodecTypeAudio)
	if parked == nil {
		t.Fatal("the closed microphone section is not parked")
	}

	subscriber.Close()
	pub := publisher.publication("mic")
	if _, err := subscriber.attach(newEgressTrack(pub, subscriber.transport), parked); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("attach on a closed session returned %v, want ErrSessionGone", err)
	}
}

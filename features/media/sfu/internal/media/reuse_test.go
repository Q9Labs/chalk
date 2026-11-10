package media

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
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

// Reusing an audio receiver can leave Chromium's MediaStreamTrack silent even while
// its RTP and sample counters advance. Keep a fresh receiver until audio reuse is proved.
func TestAudioRepullGetsAFreshReceiverIdentity(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)
	first, original := pullAndAnswer(t, subscriber, publisher, viewer, "mic")
	forceClose(t, subscriber, first)
	next, sections := pullAndAnswer(t, subscriber, publisher, viewer, "mic")
	if next == first || len(sections[next].ssrcs) == 0 || slices.Equal(sections[next].ssrcs, original[first].ssrcs) {
		t.Fatalf("audio repull reused receiver identity: mid %s -> %s, SSRCs %v -> %v", first, next, original[first].ssrcs, sections[next].ssrcs)
	}
}

func TestVideoSectionsFollowLiveTracksNotPulls(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)

	const pulls = 100
	firstSize := 0
	seen := map[string]bool{}
	for pull := range pulls {
		name := "cam"
		mid, sections := pullAndAnswer(t, subscriber, publisher, viewer, name)
		seen[mid] = true
		if got := len(subscriber.pc.GetTransceivers()); got > 1 {
			t.Fatalf("pull %d: the node holds %d sections for one live video track, want at most 1", pull, got)
		}
		if got := len(viewer.pc.GetTransceivers()); got > 1 {
			t.Fatalf("pull %d: the client holds %d sections, want at most 1", pull, got)
		}
		if section := sections[mid]; section.direction != "sendonly" || section.port == 0 || len(section.ssrcs) == 0 {
			t.Fatalf("pull %d: the section %s of the response is %+v, want an active sendonly section with a source", pull, mid, section)
		}
		for other, section := range sections {
			if other != mid && len(section.ssrcs) != 0 {
				t.Fatalf("pull %d: section %s still announces a source %v while its track is closed", pull, other, section.ssrcs)
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
	if len(seen) > 1 {
		t.Fatalf("%d pulls used %d mids, want 1 (video)", pulls, len(seen))
	}
	t.Logf("%d video pulls used mids %v; the client offer stayed near %d bytes", pulls, fmt.Sprint(seen), firstSize)
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
	offer, err := subscriber.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	first := readSections(t, offer.SDP)
	forceClose(t, subscriber, cam)
	mid, sections := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	if mid != cam {
		t.Fatalf("camera pull got mid %s, want the parked %s", mid, cam)
	}
	if got := sections[cam]; got.direction != "sendonly" || got.port == 0 || len(got.ssrcs) == 0 || !slices.Equal(got.ssrcs, first[cam].ssrcs) {
		t.Fatalf("reused camera section is %+v, want sendonly with the original SSRCs %v", got, first[cam].ssrcs)
	}
	if got := sections[mic]; got.direction != "sendonly" || !slices.Equal(got.ssrcs, first[mic].ssrcs) {
		t.Fatalf("the live microphone section changed with the camera pull: %+v", got)
	}

	forceClose(t, subscriber, mic)
	forceClose(t, subscriber, cam)
	mid, sections = pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	if mid != cam || sections[cam].direction != "sendonly" {
		t.Fatalf("camera pull got mid %s with section %+v, want %s sendonly", mid, sections[mid], cam)
	}
	if got := sections[mic]; len(got.ssrcs) != 0 {
		t.Fatalf("closed audio section still announces a source: %+v", got)
	}
}

func TestANegotiatedCloseFreesTheMidAndARejectedSectionIsNeverReused(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)
	_, cam := pullBoth(t, subscriber, publisher, viewer)

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

	closeNegotiated(cam, false)
	if mid, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam"); mid != cam {
		t.Fatalf("after a negotiated close that parked the section the pull got mid %s, want %s", mid, cam)
	}

	// An older client stops the transceiver, so its offer rejects the section (port 0). A browser
	// treats that section as gone for good, so the node must add a new one.
	closeNegotiated(cam, true)
	mid, sections := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	if mid == cam {
		t.Fatalf("the pull reused mid %s, which the client rejected", cam)
	}
	if got := sections[cam]; got.port != 0 && got.direction != "inactive" {
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

// setDirection gives one section of an SDP the direction a browser's offer has for a parked receiver.
func setDirection(t *testing.T, raw, mid, direction string) string {
	t.Helper()
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	for _, media := range description.MediaDescriptions {
		if got, _ := media.Attribute(sdp.AttrKeyMID); got != mid {
			continue
		}
		for index, attribute := range media.Attributes {
			if isDirection(attribute.Key) {
				media.Attributes[index] = sdp.Attribute{Key: direction}
			}
		}
	}
	out, err := description.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// extensionsOf lists the header extension URIs of one section.
func extensionsOf(t *testing.T, raw, mid string) []string {
	t.Helper()
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	var uris []string
	for _, media := range description.MediaDescriptions {
		if got, _ := media.Attribute(sdp.AttrKeyMID); got != mid {
			continue
		}
		for _, attribute := range media.Attributes {
			if attribute.Key == sdp.AttrKeyExtMap {
				uris = append(uris, strings.Fields(attribute.Value)[1])
			}
		}
	}
	slices.Sort(uris)
	return uris
}

// The SDK parks a closed receiver as inactive and repeats that in every offer it makes. Pion stops a
// transceiver whose mid an offer marks inactive, which would end the reuse of a parked section at
// the guest's next publish or close. The answer must also keep the header extensions the client
// offered on that section, or a browser drops the RID extension from its bundle and refuses its next
// simulcast offer.
func TestAClientOfferThatLeavesAParkedSectionInactiveDoesNotEndItsReuse(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)
	mic, cam := pullBoth(t, subscriber, publisher, viewer)

	forceClose(t, subscriber, cam)
	offer := viewer.offer(t)
	offer.SDP = setDirection(t, offer.SDP, cam, "inactive")
	offer.SDP = setDirection(t, offer.SDP, mic, "inactive")
	closed, err := subscriber.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: offer, Tracks: []protocol.CloseTrack{{Mid: mic}}})
	if err != nil || closed.SessionDescription == nil {
		t.Fatalf("negotiated close of the mic with the camera parked: %+v, %v", closed, err)
	}
	answered := readSections(t, closed.SessionDescription.SDP)
	if got := answered[cam]; got.direction != "inactive" {
		t.Fatalf("the answer to the client's inactive camera section is %s, want inactive", got.direction)
	}
	if want, got := extensionsOf(t, offer.SDP, cam), extensionsOf(t, closed.SessionDescription.SDP, cam); !slices.Equal(want, got) {
		t.Fatalf("the answer keeps the extensions %v on the parked camera section, the client offered %v", got, want)
	}
	if err := viewer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: closed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}

	// The node's own offers keep the RID extension on the parked camera section for the same reason.
	pulled, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, "mic"))
	if err != nil || pulled.SessionDescription == nil {
		t.Fatalf("pull mic: %+v, %v", pulled, err)
	}
	if !slices.Contains(extensionsOf(t, pulled.SessionDescription.SDP, cam), "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id") {
		t.Fatalf("the node's offer drops the RID extension from the parked camera section: %v", extensionsOf(t, pulled.SessionDescription.SDP, cam))
	}
	answer := viewer.answer(t, pulled.SessionDescription)
	if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: answer}); err != nil {
		t.Fatal(err)
	}
	forceClose(t, subscriber, pulled.Tracks[0].Mid)

	mid, sections := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	if mid != cam {
		t.Fatalf("the camera pull got mid %s after the client's offer, want the parked %s", mid, cam)
	}
	if got := sections[cam]; got.port == 0 || got.direction != "sendonly" || len(got.ssrcs) == 0 {
		t.Fatalf("the reused camera section is %+v, want an active sendonly section with a source", got)
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

// A section numbers its RTX stream from one counter that every subscription's binding on it shares.
// A writer of a closed subscription that is still running, such as a bandwidth probe, takes a number
// from the same counter as the subscription that reused the section, so no number is used twice on
// the reused SSRC: the transport derives the SRTP index of an SSRC from the packets it sends, and a
// repeated number is dropped by the receiver as a replay.
func TestReuseCyclesNeverRepeatARepairSequenceNumber(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)

	bindingOf := func(mid string) *egressBinding {
		subscriber.mu.Lock()
		defer subscriber.mu.Unlock()
		return subscriber.subscribed[mid].track.binding.Load()
	}
	mid, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	old := bindingOf(mid)
	if old == nil || old.rtxSSRC == 0 {
		t.Fatalf("the camera binding %+v has no RTX stream", old)
	}

	seen := map[uint16]int{}
	var last uint16
	record := func(cycle int, who string, binding *egressBinding) {
		seq := binding.nextRTXSeq()
		if previous, ok := seen[seq]; ok {
			t.Fatalf("cycle %d: %s took RTX sequence number %d, already taken in cycle %d", cycle, who, seq, previous)
		}
		if len(seen) > 0 && seq != last+1 {
			t.Fatalf("cycle %d: %s took %d after %d, the section's sequence must move by one per allocation", cycle, who, seq, last)
		}
		seen[seq], last = cycle, seq
	}

	const cycles = 20
	for cycle := range cycles {
		record(cycle, "the subscription", old)
		forceClose(t, subscriber, mid)
		again, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
		if again != mid {
			t.Fatalf("cycle %d: the camera got mid %s, want %s", cycle, again, mid)
		}
		current := bindingOf(mid)
		if current == old {
			t.Fatalf("cycle %d: the reused section kept the closed subscription's binding", cycle)
		}
		// The closed subscription's probe loop was inside a write when the section was reused.
		record(cycle, "a probe of the closed subscription", old)
		record(cycle, "the new subscription", current)
		old = current
	}
}

// A capture session (the recorder) never reuses a section: its receiver binds a track on the
// track event of a new SSRC, and a reused section fires none. Each re-pull gets a fresh mid and a
// fresh SSRC, as before section reuse.
func TestACaptureSessionGetsAFreshSectionForEveryPull(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	publishMedia(t, publisher)
	scope := testScope("recorder", 1)
	created, err := node.CreateCaptureSession("capture-reuse", scope)
	if err != nil {
		t.Fatal(err)
	}
	capture, err := node.Session(created.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	viewer := newTestPeer(t)

	seen := map[string]bool{}
	const cycles = 5
	for cycle := range cycles {
		mid, _ := pullAndAnswer(t, capture, publisher, viewer, "cam")
		if seen[mid] {
			t.Fatalf("cycle %d: the capture session reused mid %s, want a fresh section for every pull", cycle, mid)
		}
		seen[mid] = true
		forceClose(t, capture, mid)
	}
	if got := len(capture.free); got != 0 {
		t.Fatalf("the capture session parked %d sections, want none", got)
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
	mid, _ := pullAndAnswer(t, subscriber, publisher, viewer, "cam")
	forceClose(t, subscriber, mid)
	parked := subscriber.freeSection(webrtc.RTPCodecTypeVideo)
	if parked == nil {
		t.Fatal("the closed camera section is not parked")
	}

	subscriber.Close()
	pub := publisher.publication("cam")
	if _, err := subscriber.attach(newEgressTrack(pub, subscriber.transport), parked); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("attach on a closed session returned %v, want ErrSessionGone", err)
	}
}

// A held section answers only with the extensions a live section negotiates. The set in hold.go must
// stay equal to what the node's engine puts in its own offers.
func TestHeldSectionsAnswerOnlyWithExtensionsTheNodeNegotiates(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publishMedia(t, publisher)
	viewer := newTestPeer(t)
	_, cam := pullBoth(t, subscriber, publisher, viewer)

	// The live offers of a fresh subscriber name every extension the node's engine negotiates.
	live := map[string]bool{}
	fresh := node.newTestSession(t, testScope("carol", 1))
	freshViewer := newTestPeer(t)
	for _, name := range []string{"mic", "cam"} {
		pulled, err := fresh.AddTracks(context.Background(), pullRequest(fresh, publisher, name))
		if err != nil || pulled.SessionDescription == nil {
			t.Fatalf("pull %s: %+v, %v", name, pulled, err)
		}
		var description sdp.SessionDescription
		if err := description.Unmarshal([]byte(pulled.SessionDescription.SDP)); err != nil {
			t.Fatal(err)
		}
		for _, media := range description.MediaDescriptions {
			for _, attribute := range media.Attributes {
				if attribute.Key == sdp.AttrKeyExtMap {
					live[strings.Fields(attribute.Value)[1]] = true
				}
			}
		}
		answer := freshViewer.answer(t, pulled.SessionDescription)
		if err := fresh.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: fresh.scope, SessionDescription: answer}); err != nil {
			t.Fatal(err)
		}
	}
	for uri := range live {
		if !answerableExtensions[uri] {
			t.Fatalf("the node's own offer carries %s, which the held sections would not echo", uri)
		}
	}
	for uri := range answerableExtensions {
		if !live[uri] {
			t.Fatalf("answerableExtensions lists %s, which the node's own offer never carries", uri)
		}
	}

	// An extension the node does not negotiate, offered on a held section, is left out of the answer.
	offer := viewer.offer(t)
	offer.SDP = setDirection(t, offer.SDP, cam, "inactive")
	offer.SDP = withExtension(t, offer.SDP, cam, "13 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time")
	forceClose(t, subscriber, cam)
	closed, err := subscriber.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: offer, Tracks: []protocol.CloseTrack{{Mid: cam}}})
	if err != nil || closed.SessionDescription == nil {
		t.Fatalf("close: %+v, %v", closed, err)
	}
	if got := extensionsOf(t, closed.SessionDescription.SDP, cam); slices.Contains(got, "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time") || !slices.Contains(got, sdp.SDESRTPStreamIDURI) {
		t.Fatalf("the held camera section answers with %v, want the negotiated extensions and not abs-send-time", got)
	}
}

// withExtension adds one extmap line to a section.
func withExtension(t *testing.T, raw, mid, value string) string {
	t.Helper()
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	for _, media := range description.MediaDescriptions {
		if got, _ := media.Attribute(sdp.AttrKeyMID); got == mid {
			media.Attributes = append(media.Attributes, sdp.Attribute{Key: sdp.AttrKeyExtMap, Value: value})
		}
	}
	out, err := description.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// An extmap value is "<id>[/<direction>] <uri> [<attributes>]" (RFC 8285 section 5). The URI is the
// second token, so a direction on the id or an attribute after the URI neither hides a negotiated
// extension nor lets an unknown one in. The answer restricts the offered direction (section 6),
// keeps the attributes, and drops what it cannot answer.
func TestAnswerableAnswersEachOfferedExtmapLineAsTheRFCAllows(t *testing.T) {
	mid, rid, repaired, audio := sdp.SDESMidURI, sdp.SDESRTPStreamIDURI, sdp.SDESRepairRTPStreamIDURI, sdp.AudioLevelURI
	for _, test := range []struct {
		name, offered, want string
	}{
		{"no direction answers without one", "3 " + mid, "3 " + mid},
		{"sendrecv answers without a direction", "3/sendrecv " + mid, "3 " + mid},
		{"sendonly is answered recvonly", "3/sendonly " + mid, "3/recvonly " + mid},
		{"recvonly is answered sendonly", "3/recvonly " + mid, "3/sendonly " + mid},
		{"inactive stays inactive", "3/inactive " + mid, "3/inactive " + mid},
		{"a trailing attribute is kept", "10 " + rid + " urn:example:attribute", "10 " + rid + " urn:example:attribute"},
		{"direction and trailing attribute together", "11/recvonly " + repaired + " mode=a", "11/sendonly " + repaired + " mode=a"},
		{"two-byte id", "200 " + audio, "200 " + audio},
		{"an unknown URI is dropped", "13 " + sdp.ABSSendTimeURI, ""},
		{"a URI only in the attributes is dropped", "14/sendonly " + sdp.ABSSendTimeURI + " " + mid, ""},
		{"an unknown direction is dropped", "3/sideways " + mid, ""},
		{"id 0 is dropped", "0 " + mid, ""},
		{"id 256 is dropped", "256 " + mid, ""},
		{"a non-numeric id is dropped", "x " + mid, ""},
		{"a line without a URI is dropped", "3", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := answerable([]sdp.Attribute{{Key: sdp.AttrKeyExtMap, Value: test.offered}, {Key: sdp.AttrKeyRecvOnly}})
			switch {
			case test.want == "" && len(got) != 0:
				t.Fatalf("answerable kept %+v, want nothing", got)
			case test.want != "" && (len(got) != 1 || got[0].Key != sdp.AttrKeyExtMap || got[0].Value != test.want):
				t.Fatalf("answerable kept %+v, want %q", got, test.want)
			}
		})
	}
}

// An answer maps an id once and offers an extension once, whatever the offer repeats.
func TestAnswerableAnswersEachIDAndURIOnce(t *testing.T) {
	line := func(value string) sdp.Attribute { return sdp.Attribute{Key: sdp.AttrKeyExtMap, Value: value} }
	got := answerable([]sdp.Attribute{
		line("3 " + sdp.SDESMidURI),
		line("4 " + sdp.SDESMidURI),
		line("3 " + sdp.AudioLevelURI),
		line("5 " + sdp.AudioLevelURI),
	})
	if len(got) != 2 || got[0].Value != "3 "+sdp.SDESMidURI || got[1].Value != "5 "+sdp.AudioLevelURI {
		t.Fatalf("answerable kept %+v, want 3 sdes:mid and 5 audio-level", got)
	}
}

// RFC 8285 section 5 lets an offer declare an extension once at session level for every media
// section. A held section answers it on its own section, because the answer's session level is Pion's.
func TestAHeldSectionAnswersAnExtensionTheOfferDeclaresAtSessionLevel(t *testing.T) {
	const offer = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n" +
		"a=extmap:4 " + sdp.SDESRTPStreamIDURI + "\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=inactive\r\na=rtpmap:96 VP8/90000\r\n" +
		"a=extmap:5 " + sdp.SDESMidURI + "\r\n"
	const answer = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\n"
	released, err := releaseParked(answer, offer, []string{"1"})
	if err != nil {
		t.Fatal(err)
	}
	got := extensionsOf(t, released, "1")
	slices.Sort(got)
	if want := []string{sdp.SDESMidURI, sdp.SDESRTPStreamIDURI}; !slices.Equal(got, want) {
		t.Fatalf("the held section answers with %v, want %v", got, want)
	}
}

// A section with no direction of its own has the session's. An offer that says inactive once at
// session level still parks nothing for Pion to stop.
func TestHoldingAParkedSectionReadsTheDirectionItInheritsFromTheSession(t *testing.T) {
	const section = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=rtpmap:96 VP8/90000\r\n"
	const head = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n"
	for _, test := range []struct {
		name, offer string
		held        bool
	}{
		{"session inactive is inherited", head + "a=inactive\r\n" + section, true},
		{"the section's own direction wins", head + "a=inactive\r\n" + section + "a=sendrecv\r\n", false},
		{"no direction is sendrecv", head + section, false},
		{"its own inactive", head + section + "a=inactive\r\n", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			held, err := retargetSections(test.offer, map[string]bool{"1": true}, sdp.AttrKeyInactive, sdp.AttrKeyRecvOnly)
			if err != nil {
				t.Fatal(err)
			}
			if got := len(held.mids) == 1; got != test.held {
				t.Fatalf("held mids %v, want held=%v", held.mids, test.held)
			}
			if test.held && !strings.Contains(held.sdp, "a=recvonly") {
				t.Fatalf("the held section has no direction of its own:\n%s", held.sdp)
			}
		})
	}
}

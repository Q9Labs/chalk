package pion

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPacedAudioVideoCaptureAndVideoPLI(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	audioExpected := testTrack("0")
	videoExpected := testTrack("1")
	videoExpected.Source = captureplane.TrackSourceCamera
	videoExpected.Kind = captureplane.TrackKindVideo
	recorder, err := NewPeer(Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatalf("new recorder peer: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	if err := recorder.RegisterTracks([]captureplane.PulledCaptureTrack{audioExpected, videoExpected}); err != nil {
		t.Fatalf("register A/V tracks: %v", err)
	}

	publisher, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new publisher peer: %v", err)
	}
	t.Cleanup(func() { _ = publisher.Close() })
	audioLocal, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2}, "audio", "publisher")
	if err != nil {
		t.Fatalf("new audio track: %v", err)
	}
	videoLocal, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000}, "video", "publisher")
	if err != nil {
		t.Fatalf("new video track: %v", err)
	}
	if _, err := publisher.AddTrack(audioLocal); err != nil {
		t.Fatalf("add audio track: %v", err)
	}
	videoSender, err := publisher.AddTrack(videoLocal)
	if err != nil {
		t.Fatalf("add video track: %v", err)
	}
	offer, err := publisher.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create publisher offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(publisher)
	if err := publisher.SetLocalDescription(offer); err != nil {
		t.Fatalf("set publisher offer: %v", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("publisher ICE gathering timed out")
	}
	remoteOffer, err := localDescription(publisher)
	if err != nil {
		t.Fatalf("publisher local offer: %v", err)
	}
	answer, err := recorder.AnswerRemoteOffer(ctx, captureplane.Negotiation{ID: "paced-av", Requirement: captureplane.NegotiationAnswerNeeded, Description: &remoteOffer})
	if err != nil {
		t.Fatalf("answer publisher offer: %v", err)
	}
	setRemoteDescription(t, publisher, webrtc.SDPTypeAnswer, answer.SDP)

	mediaCtx, stopMedia := context.WithCancel(ctx)
	defer stopMedia()
	go writePacedTestMedia(mediaCtx, audioLocal, videoLocal)
	audioRemote, err := recorder.WaitForTrack(ctx, "0")
	if err != nil {
		t.Fatalf("wait for audio: %v", err)
	}
	videoRemote, err := recorder.WaitForTrack(ctx, "1")
	if err != nil {
		t.Fatalf("wait for video: %v", err)
	}
	if audioRemote.Codec() != "opus" || videoRemote.Codec() != "vp8" {
		t.Fatalf("negotiated codecs = %s/%s", audioRemote.Codec(), videoRemote.Codec())
	}
	if err := recorder.RequestKeyFrame("1"); err != nil {
		t.Fatalf("request video keyframe: %v", err)
	}
	if err := videoSender.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set RTCP read deadline: %v", err)
	}
	packets, _, err := videoSender.ReadRTCP()
	if err != nil {
		t.Fatalf("read publisher RTCP: %v", err)
	}
	foundPLI := false
	for _, packet := range packets {
		if _, ok := packet.(*rtcp.PictureLossIndication); ok {
			foundPLI = true
		}
	}
	if !foundPLI {
		t.Fatalf("publisher RTCP did not contain PLI: %#v", packets)
	}
	if packet, _, err := audioRemote.ReadRTP(); err != nil || len(packet.Payload) == 0 {
		t.Fatalf("read paced audio RTP: packet=%v err=%v", packet, err)
	}
	if packet, _, err := videoRemote.ReadRTP(); err != nil || len(packet.Payload) == 0 {
		t.Fatalf("read paced video RTP: packet=%v err=%v", packet, err)
	}
}

func writePacedTestMedia(ctx context.Context, audio, video *webrtc.TrackLocalStaticRTP) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	var sequence uint16
	var audioTimestamp, videoTimestamp uint32
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sequence++
			audioTimestamp += 960
			videoTimestamp += 1_800
			_ = audio.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: audioTimestamp, SSRC: 1001}, Payload: []byte{0xf8, 0xff, 0xfe}})
			_ = video.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: videoTimestamp, SSRC: 2001, Marker: true}, Payload: []byte{0x10, 0, 0}})
		}
	}
}

const (
	testTenant      = "00000000-0000-4000-8000-000000000001"
	testSpace       = "00000000-0000-4000-8000-000000000002"
	testEpisode     = "00000000-0000-4000-8000-000000000003"
	testRecording   = "00000000-0000-4000-8000-000000000004"
	testParticipant = "00000000-0000-4000-8000-000000000005"
)

func setRemoteDescription(t *testing.T, peer *webrtc.PeerConnection, kind webrtc.SDPType, sdp string) {
	t.Helper()
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: kind, SDP: sdp}); err != nil {
		t.Fatalf("set remote description: %v", err)
	}
}

func TestLocalOfferRemoteAnswerAndStaleAnswer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	peer := newTestPeer(t, "0")
	negotiation, err := peer.CreateLocalOffer(ctx, "provider-offer-1")
	if err != nil {
		t.Fatalf("create local offer: %v", err)
	}
	if negotiation.Requirement != captureplane.NegotiationOfferNeeded || negotiation.Description == nil || negotiation.Description.Type != "offer" {
		t.Fatalf("local negotiation = %+v", negotiation)
	}
	if !strings.Contains(negotiation.Description.SDP, "a=mid:0") {
		t.Fatalf("local offer did not preserve expected MID: %s", negotiation.Description.SDP)
	}

	remote, _, _ := newTestSenderWithTrack(t)
	defer remote.Close()
	offer, err := toPionDescription(*negotiation.Description)
	if err != nil {
		t.Fatalf("convert offer: %v", err)
	}
	if err := remote.SetRemoteDescription(offer); err != nil {
		t.Fatalf("remote set offer: %v", err)
	}
	answer, err := remote.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("remote create answer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(remote)
	if err := remote.SetLocalDescription(answer); err != nil {
		t.Fatalf("remote set answer: %v", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("remote ICE gathering timed out")
	}
	remoteAnswer, err := localDescription(remote)
	if err != nil {
		t.Fatalf("remote local answer: %v", err)
	}
	if err := peer.ApplyRemoteAnswer(ctx, captureplane.Negotiation{Requirement: captureplane.NegotiationRemoteAnswer, Description: &remoteAnswer}); err != nil {
		t.Fatalf("apply remote answer: %v", err)
	}
	if err := peer.ApplyRemoteAnswer(ctx, captureplane.Negotiation{Requirement: captureplane.NegotiationRemoteAnswer, Description: &remoteAnswer}); !errors.Is(err, ErrStaleNegotiation) {
		t.Fatalf("duplicate remote answer error = %v, want stale", err)
	}
}

func TestRemoteOfferLocalAnswerAndMIDBinding(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	peer := newTestPeer(t, "0")
	remote, sender, _ := newTestSenderWithTrack(t)
	defer remote.Close()
	offer, err := remote.CreateOffer(nil)
	if err != nil {
		t.Fatalf("remote create offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(remote)
	if err := remote.SetLocalDescription(offer); err != nil {
		t.Fatalf("remote set offer: %v", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("remote ICE gathering timed out")
	}
	remoteOffer, err := localDescription(remote)
	if err != nil {
		t.Fatalf("remote local offer: %v", err)
	}
	answer, err := peer.AnswerRemoteOffer(ctx, captureplane.Negotiation{
		ID:          "provider-offer-1",
		Requirement: captureplane.NegotiationAnswerNeeded,
		Description: &remoteOffer,
	})
	if err != nil {
		t.Fatalf("answer remote offer: %v", err)
	}
	if answer.Type != "answer" || !strings.Contains(answer.SDP, "a=mid:0") {
		t.Fatalf("local answer = %+v", answer)
	}
	setRemoteDescription(t, remote, webrtc.SDPTypeAnswer, answer.SDP)

	packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: 1, Timestamp: 1, SSRC: 42}, Payload: []byte{1, 2, 3}}
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		for sequence := uint16(1); sequence < 40; sequence++ {
			packet.SequenceNumber = sequence
			_ = sender.WriteRTP(&rtp.Packet{Header: packet.Header, Payload: append([]byte(nil), packet.Payload...)})
			time.Sleep(20 * time.Millisecond)
		}
	}()
	track, err := peer.WaitForTrack(ctx, "0")
	if err != nil {
		t.Fatalf("wait for track: %v", err)
	}
	<-sent
	if track.CaptureTrack().ParticipantID.IsZero() || track.MID() != "0" || track.Codec() != "opus" {
		t.Fatalf("bound track lost Chalk identity: %+v", track.CaptureTrack())
	}
	received, _, err := track.ReadRTP()
	if err != nil {
		t.Fatalf("read RTP: %v", err)
	}
	if received.SequenceNumber == 0 || string(received.Payload) != string([]byte{1, 2, 3}) {
		t.Fatalf("packet = %+v", received)
	}
}

func TestUnknownMIDAndDuplicateRegistrationAreRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	peer, err := NewPeer(Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatalf("new peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	duplicate := testTrack("0")
	if err := peer.RegisterTracks([]captureplane.PulledCaptureTrack{testTrack("0"), duplicate}); !errors.Is(err, ErrDuplicateMID) {
		t.Fatalf("duplicate registration error = %v", err)
	}
	unknownPeer := newTestPeer(t, "0")

	remote, _, _ := newTestSenderWithTrack(t)
	defer remote.Close()
	offer, err := remote.CreateOffer(nil)
	if err != nil {
		t.Fatalf("remote create offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(remote)
	if err := remote.SetLocalDescription(offer); err != nil {
		t.Fatalf("remote set offer: %v", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("remote ICE gathering timed out")
	}
	remoteOffer, err := localDescription(remote)
	if err != nil {
		t.Fatalf("remote local offer: %v", err)
	}
	remoteOffer.SDP = strings.Replace(remoteOffer.SDP, "a=mid:0", "a=mid:unknown", 1)
	remoteOffer.SDP = strings.Replace(remoteOffer.SDP, "a=group:BUNDLE 0", "a=group:BUNDLE unknown", 1)
	if _, err := unknownPeer.AnswerRemoteOffer(ctx, captureplane.Negotiation{ID: "provider-offer-unknown", Requirement: captureplane.NegotiationAnswerNeeded, Description: &remoteOffer}); !errors.Is(err, ErrUnknownMID) {
		t.Fatalf("unknown MID error = %v", err)
	}
}

func TestLocalOfferRejectsMIDsThatPionCannotBind(t *testing.T) {
	peer := newTestPeer(t, "provider-mid")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := peer.CreateLocalOffer(ctx, "provider-offer-unknown"); !errors.Is(err, ErrUnknownMID) {
		t.Fatalf("local unknown MID error = %v", err)
	}
}

func TestConcurrentOffersAreSerialized(t *testing.T) {
	peer := newTestPeer(t, "0")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var wait sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := peer.CreateLocalOffer(ctx, "provider-offer-serialized")
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	var successes, pending int
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrNegotiationPending):
			pending++
		default:
			t.Fatalf("serialized offer error = %v", err)
		}
	}
	if successes != 1 || pending != 1 {
		t.Fatalf("offers succeeded=%d pending=%d, want one each", successes, pending)
	}
}

func TestHandleOfferNeededPreservesProviderNegotiationID(t *testing.T) {
	peer := newTestPeer(t, "0")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const providerID = captureplane.ProviderReference("cloudflare-negotiation-17")

	result, err := peer.Handle(ctx, captureplane.Negotiation{ID: providerID, Requirement: captureplane.NegotiationOfferNeeded})
	if err != nil {
		t.Fatalf("handle offer-needed: %v", err)
	}
	if result.Negotiation.ID != providerID {
		t.Fatalf("negotiation ID = %q, want %q", result.Negotiation.ID, providerID)
	}
	if result.Negotiation.Description == nil || result.LocalDescription == nil || result.Negotiation.Description != result.LocalDescription {
		t.Fatalf("offer descriptions were not returned under provider fence: %+v", result)
	}
}

func TestRepeatedTrackReconciliationAddsTransceiverAndAcceptsReplacement(t *testing.T) {
	peer := newTestPeer(t, "0")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	firstOffer, err := peer.CreateLocalOffer(ctx, "cloudflare-negotiation-1")
	if err != nil {
		t.Fatalf("first local offer: %v", err)
	}
	remote, _, _ := newTestSenderWithTrack(t)
	defer remote.Close()
	setRemoteDescription(t, remote, webrtc.SDPTypeOffer, firstOffer.Description.SDP)
	answer, err := remote.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("remote create first answer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(remote)
	if err := remote.SetLocalDescription(answer); err != nil {
		t.Fatalf("remote set first answer: %v", err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("remote ICE gathering timed out")
	}
	remoteAnswer, err := localDescription(remote)
	if err != nil {
		t.Fatalf("remote first answer: %v", err)
	}
	if err := peer.ApplyRemoteAnswer(ctx, captureplane.Negotiation{Requirement: captureplane.NegotiationRemoteAnswer, Description: &remoteAnswer}); err != nil {
		t.Fatalf("apply first answer: %v", err)
	}

	if err := peer.RegisterTracks([]captureplane.PulledCaptureTrack{testTrack("0"), testTrack("1")}); err != nil {
		t.Fatalf("reconcile additional track: %v", err)
	}
	secondOffer, err := peer.CreateLocalOffer(ctx, "cloudflare-negotiation-2")
	if err != nil {
		t.Fatalf("second local offer: %v", err)
	}
	if !strings.Contains(secondOffer.Description.SDP, "a=mid:1") {
		t.Fatalf("second offer did not add MID 1: %s", secondOffer.Description.SDP)
	}

	replacement := testTrack("0")
	replacement.TrackReference = "replacement-track"
	if err := peer.RegisterTracks([]captureplane.PulledCaptureTrack{replacement}); err != nil {
		t.Fatalf("register replacement: %v", err)
	}
	if got := peer.expected["0"].TrackReference; got != replacement.TrackReference {
		t.Fatalf("replacement track = %q, want %q", got, replacement.TrackReference)
	}
	if _, exists := peer.expected["1"]; exists {
		t.Fatal("complete registration retained a removed MID")
	}
}

func TestSequentialRegistrationPreservesMIDsBeyondSingleDigits(t *testing.T) {
	peer, err := NewPeer(Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatalf("new peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	tracks := make([]captureplane.PulledCaptureTrack, 0, 11)
	for index := 0; index < 11; index++ {
		track := testTrack(strconv.Itoa(index))
		track.ParticipantGeneration = int64(index + 1)
		tracks = append(tracks, track)
	}
	if err := peer.RegisterTracks(tracks); err != nil {
		t.Fatalf("register tracks: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	negotiation, err := peer.CreateLocalOffer(ctx, "provider-negotiation-many-tracks")
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	var mids []string
	for _, line := range strings.Split(negotiation.Description.SDP, "\r\n") {
		if strings.HasPrefix(line, "a=mid:") {
			mids = append(mids, strings.TrimPrefix(line, "a=mid:"))
		}
	}
	if len(mids) != len(tracks) {
		t.Fatalf("offer MIDs = %v, want %d mids", mids, len(tracks))
	}
	for index, mid := range mids {
		want := strconv.Itoa(index)
		if mid != want {
			t.Fatalf("offer MID %d = %q, want %q (registration order %v)", index, mid, want, mids)
		}
	}
}

func TestCompleteTrackRegistrationEnforcesLimit(t *testing.T) {
	peer, err := NewPeer(Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatalf("new peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	tracks := make([]captureplane.PulledCaptureTrack, 0, maxMediaTracks)
	for index := 0; index < maxMediaTracks; index++ {
		track := testTrack(strconv.Itoa(index))
		track.ParticipantGeneration = int64(index + 1)
		tracks = append(tracks, track)
	}
	if err := peer.RegisterTracks(tracks); err != nil {
		t.Fatalf("register complete track set: %v", err)
	}
	if got := len(peer.expected); got != maxMediaTracks {
		t.Fatalf("registered MID count = %d, want %d", got, maxMediaTracks)
	}
	extra := testTrack(strconv.Itoa(maxMediaTracks))
	extra.ParticipantGeneration = maxMediaTracks + 1
	if err := peer.RegisterTracks(append(tracks, extra)); !errors.Is(err, captureplane.ErrInvalidTrack) {
		t.Fatalf("complete-set limit error = %v", err)
	}
	if got := len(peer.expected); got != maxMediaTracks {
		t.Fatalf("MID count changed after rejected reconciliation: %d", got)
	}
	if got := len(peer.registeredTracks); got != maxMediaTracks {
		t.Fatalf("registered track count changed after rejected reconciliation: %d", got)
	}
}

func newTestPeer(t *testing.T, mid string) *Peer {
	t.Helper()
	peer, err := NewPeer(Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatalf("new peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	if err := peer.RegisterTracks([]captureplane.PulledCaptureTrack{testTrack(mid)}); err != nil {
		t.Fatalf("register track: %v", err)
	}
	return peer
}

func newTestSenderWithTrack(t *testing.T) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticRTP, webrtc.RTPCodecParameters) {
	t.Helper()
	remote, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new remote peer: %v", err)
	}
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2}, PayloadType: 111}
	track, err := webrtc.NewTrackLocalStaticRTP(codec.RTPCodecCapability, "remote-track", "remote-stream")
	if err != nil {
		remote.Close()
		t.Fatalf("new local track: %v", err)
	}
	if _, err := remote.AddTrack(track); err != nil {
		remote.Close()
		t.Fatalf("add local track: %v", err)
	}
	return remote, track, codec
}

func testTrack(mid string) captureplane.PulledCaptureTrack {
	participant, _ := utilities.ParseID(testParticipant)
	return captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
		OwnerReference:        "owner",
		TrackReference:        captureplane.ProviderReference("track-" + mid),
		ParticipantID:         participant,
		ParticipantGeneration: 1,
		Source:                captureplane.TrackSourceMicrophone,
		Kind:                  captureplane.TrackKindAudio,
		RequestedLayer:        captureplane.TrackLayerAuto,
	}, MID: captureplane.ProviderReference(mid)}
}

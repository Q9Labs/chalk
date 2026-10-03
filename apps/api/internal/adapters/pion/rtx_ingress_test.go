package pion

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

type ingressTracePublisher struct {
	*webrtc.TrackLocalStaticRTP
	bound chan webrtc.TrackLocalContext
}

func (track *ingressTracePublisher) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	codec, err := track.TrackLocalStaticRTP.Bind(ctx)
	if err == nil {
		track.bound <- ctx
	}
	return codec, err
}

// These scalar relationships come from the retained synthetic ingress trace:
// primary 17447 and de-RTX 18476 had timestamp 784274428, PictureID 16999,
// identical payload fingerprints and length 1177; RTX transport sequence was 99.
// No media was retained. The body below is a synthetic replacement; SSRC/PT are
// negotiated locally. This tests the observed replay pattern, not its raw OSN cause.
func TestCaptureRejectsObservedMisplacedRTX(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	receiver, err := NewPeer(Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = receiver.Close() })
	identity := testTrack("0")
	identity.Kind, identity.Source = captureplane.TrackKindVideo, captureplane.TrackSourceCamera
	if err := receiver.RegisterTracks([]captureplane.PulledCaptureTrack{identity}); err != nil {
		t.Fatal(err)
	}
	publisher, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = publisher.Close() })
	connected := make(chan struct{}, 1)
	publisher.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	local, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "camera", "synthetic")
	if err != nil {
		t.Fatal(err)
	}
	track := &ingressTracePublisher{TrackLocalStaticRTP: local, bound: make(chan webrtc.TrackLocalContext, 1)}
	sender, err := publisher.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	offeredRTXSSRC := sender.GetParameters().Encodings[0].RTX.SSRC
	if offeredRTXSSRC == 0 {
		t.Fatal("publisher must offer an RTX SSRC")
	}
	offer, err := publisher.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(publisher)
	if err := publisher.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	description, err := localDescription(publisher)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := receiver.AnswerRemoteOffer(ctx, captureplane.Negotiation{ID: "retained-ingress-pattern", Requirement: captureplane.NegotiationAnswerNeeded, Description: &description})
	if err != nil {
		t.Fatal(err)
	}
	setRemoteDescription(t, publisher, webrtc.SDPTypeAnswer, answer.SDP)
	select {
	case <-connected:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var binding webrtc.TrackLocalContext
	select {
	case binding = <-track.bound:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	payload := make([]byte, 1177)
	copy(payload, []byte{0x90, 0x80, 0xc2, 0x67, 1}) // VP8 PictureID 16999.
	primary := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 17447, Timestamp: 784274428}, Payload: payload}
	if err := track.WriteRTP(primary); err != nil {
		t.Fatal(err)
	}
	remote, err := receiver.WaitForTrack(ctx, "0")
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	first, _, err := remote.ReadRTP()
	if err != nil || first.SequenceNumber != 17447 || !bytes.Equal(first.Payload, payload) {
		t.Fatalf("primary trace packet: %v, %v", first, err)
	}
	// Like a conforming SFU, send the retained replay pattern only if the
	// receiver's answer negotiated RTX. The primary path remains identical.
	if binding.SSRCRetransmission() != 0 {
		repair := make([]byte, len(payload)+2)
		binary.BigEndian.PutUint16(repair, 18476)
		copy(repair[2:], payload)
		header := &rtp.Header{Version: 2, PayloadType: 97, SequenceNumber: 99, Timestamp: primary.Timestamp, SSRC: uint32(offeredRTXSSRC)}
		if _, err := binding.WriteStream().WriteRTP(header, repair); err != nil {
			t.Fatal(err)
		}
	}
	// Rejecting RTX must leave subsequent primary video usable.
	primary.SequenceNumber++
	primary.Timestamp += 3000
	if err := track.WriteRTP(primary); err != nil {
		t.Fatal(err)
	}
	if err := remote.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	seenPrimary := false
	// Pion checks its RTX queue before blocking on the primary stream. Check
	// once more after timeout so a repair queued during that read is observed.
	for timeouts := 0; timeouts < 2; {
		packet, _, err := remote.ReadRTP()
		if err != nil {
			var timeout net.Error
			if !errors.As(err, &timeout) || !timeout.Timeout() {
				t.Fatal(err)
			}
			timeouts++
			continue
		}
		if packet.SequenceNumber == 18476 && bytes.Equal(packet.Payload, payload) {
			t.Fatal("Capture delivered the retained misplaced RTX replay")
		}
		seenPrimary = seenPrimary || packet.SequenceNumber == primary.SequenceNumber
	}
	if !seenPrimary {
		t.Fatal("subsequent primary video was not delivered")
	}
}

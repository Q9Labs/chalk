package chalksfu_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// peer is a Pion peer connection that talks to the SFU on loopback.
type peer struct {
	pc       *webrtc.PeerConnection
	received atomic.Int64
}

func newPeer(t *testing.T) *peer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	p := &peer{pc: pc}
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, err := remote.ReadRTP(); err != nil {
				return
			}
			p.received.Add(1)
		}
	})
	t.Cleanup(func() { _ = pc.Close() })
	return p
}

func (p *peer) describe(t *testing.T, description webrtc.SessionDescription) mediaplane.SessionDescription {
	t.Helper()
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	<-gathered
	local := p.pc.LocalDescription()
	return mediaplane.SessionDescription{SDP: local.SDP, Type: local.Type.String()}
}

func (p *peer) offer(t *testing.T) mediaplane.SessionDescription {
	t.Helper()
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	return p.describe(t, offer)
}

// answer applies the SFU's offer and returns this peer's answer.
func (p *peer) answer(t *testing.T, offer *mediaplane.SessionDescription) mediaplane.SessionDescription {
	t.Helper()
	if offer == nil || offer.Type != "offer" {
		t.Fatalf("expected an SFU offer, got %+v", offer)
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	return p.describe(t, answer)
}

func (p *peer) accept(t *testing.T, answer *mediaplane.SessionDescription) {
	t.Helper()
	if answer == nil || answer.Type != "answer" {
		t.Fatalf("expected an SFU answer, got %+v", answer)
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatal(err)
	}
}

// addAudio adds a microphone track and returns it with its MID once an offer exists.
func (p *peer) addAudio(t *testing.T, id string) *webrtc.TrackLocalStaticRTP {
	t.Helper()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, id, "peer")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	return track
}

func (p *peer) mid(t *testing.T, track *webrtc.TrackLocalStaticRTP) string {
	t.Helper()
	for _, transceiver := range p.pc.GetTransceivers() {
		if sender := transceiver.Sender(); sender != nil && sender.Track() != nil && sender.Track().ID() == track.ID() {
			return transceiver.Mid()
		}
	}
	t.Fatalf("no transceiver for track %s", track.ID())
	return ""
}

// send writes RTP packets until the context ends.
func send(ctx context.Context, track *webrtc.TrackLocalStaticRTP) {
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sequence++
				packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: sequence, Timestamp: uint32(sequence) * 960}, Payload: []byte{1, 2, 3, 4}}
				_ = track.WriteRTP(packet)
			}
		}
	}()
}

func eventually(t *testing.T, what string, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

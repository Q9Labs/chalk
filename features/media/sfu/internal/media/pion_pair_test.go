package media

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// pionPair is a server and a viewer peer connection on loopback with transport-wide feedback
// negotiated, so a test can drive the node's pacing path with real SRTP.
type pionPair struct {
	server, viewer *webrtc.PeerConnection
	connected      chan struct{}
}

// newPionPair builds the pair. onPacket receives every RTP packet the viewer reads.
func newPionPair(t *testing.T, onPacket func(*rtp.Packet)) *pionPair {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: sdp.TransportCCURI}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine))
	server, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	viewer, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = viewer.Close() })
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			onPacket(packet)
		}
	})
	connected := make(chan struct{}, 1)
	server.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state != webrtc.PeerConnectionStateConnected {
			return
		}
		select {
		case connected <- struct{}{}:
		default:
		}
	})
	return &pionPair{server: server, viewer: viewer, connected: connected}
}

// connect sends the track from the server to the viewer and waits for the connection.
func (p *pionPair) connect(t *testing.T, track webrtc.TrackLocal) *webrtc.RTPTransceiver {
	t.Helper()
	tx, err := p.server.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	offer, err := p.server.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(p.server)
	if err = p.server.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err = p.viewer.SetRemoteDescription(*p.server.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := p.viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered = webrtc.GatheringCompletePromise(p.viewer)
	if err = p.viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err = p.server.SetRemoteDescription(*p.viewer.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.connected:
	case <-time.After(10 * time.Second):
		t.Fatal("peer did not connect")
	}
	return tx
}

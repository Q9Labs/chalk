package media

import (
	"testing"
	"time"

	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// A staging feedback report marked 14 new transport sequence numbers missing
// for copies of one primary RTP packet whose first copy was acknowledged.
// Replaying the publisher repair as primary SRTP makes the viewer reject it
// before TWCC, although its media sequence space has no missing packets.
func TestTWCCLoopbackDuplicateRepairs(t *testing.T) {
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
	received := make(chan *rtp.Packet, 256)
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			received <- packet
		}
	})
	connected := make(chan struct{}, 1)
	server.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			connected <- struct{}{}
		}
	})
	pub := &publication{session: &Session{id: "publisher", pc: server}, name: "camera", kind: webrtc.RTPCodecTypeVideo, source: "camera", authority: freeAuthority()}
	tr := newTransport(&delayHistogram{}, 128<<10, nil)
	t.Cleanup(tr.close)
	track := newEgressTrack(pub, tr)
	_, err = server.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	offer, err := server.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(server)
	if err = server.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err = viewer.SetRemoteDescription(*server.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered = webrtc.GatheringCompletePromise(viewer)
	if err = viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err = server.SetRemoteDescription(*viewer.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Fatal("peer did not connect")
	}
	binding := track.binding.Load()
	if binding == nil || binding.twccID == 0 {
		t.Fatal("transport-wide feedback was not negotiated")
	}
	sub := &subscription{pub: pub, transport: tr, track: track, request: layerRequest{ceiling: "h"}, target: 0, translator: translator{clockRate: 90000}}
	sub.interest.Store(1)
	writer := &packetWriter{}
	var header rtp.Header
	layers := [2]*ingressLayer{{index: 0, rid: "l"}, {index: 1, rid: "h"}}
	for index, layer := range layers {
		layer.lastRTP.Store(monotonic())
		layer.history.Store(newHistory(128<<10, historySlots))
		pub.layers[index].Store(layer)
	}
	pub.subscribers.Store(&[]*subscription{sub})
	forward := func(layer int, seq uint64, key, repaired bool) {
		p := vp8Packet(seq, uint32(seq)*3000, uint8(seq%128), uint8(seq), true, key)
		raw, err := (&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SSRC: uint32(layer + 1), SequenceNumber: uint16(seq), Timestamp: p.timestamp, Marker: true}, Payload: p.payload}).Marshal()
		if err != nil {
			t.Fatal(err)
		}
		pub.forward(layers[layer], raw, repaired, &header, writer)
	}
	for seq := range uint64(60) {
		if seq != 50 {
			forward(0, seq, seq == 0, false)
		}
	}
	sub.target = 1
	sub.interest.Store(3)
	for seq := uint64(60); seq < 80; seq++ {
		forward(1, seq, false, false) // The new layer cannot flow before its keyframe.
		forward(0, seq, false, false)
	}
	forward(0, 50, false, true) // A repair which fills a real hole must still flow.
	for seq := uint64(80); seq < 120; seq++ {
		forward(1, seq, seq == 80, false)
	}
	for range 14 {
		forward(1, 100, false, true)
	}
	forward(1, 120, false, false)
	recorder := twcc.NewRecorder(1)
	seen := map[uint16]bool{}
	read := func(n int) {
		for range n {
			select {
			case packet := <-received:
				seen[packet.SequenceNumber] = true
				ext := &rtp.TransportCCExtension{}
				if err := ext.Unmarshal(packet.GetExtension(binding.twccID)); err != nil {
					t.Fatal(err)
				}
				recorder.Record(packet.SSRC, ext.TransportSequence, time.Now().UnixMicro())
			case <-time.After(5 * time.Second):
				t.Fatalf("packet did not arrive: received=%d", len(seen))
			}
		}
	}
	feedback := func() {
		for _, packet := range recorder.BuildFeedbackPacket() {
			raw, err := packet.Marshal()
			if err != nil {
				t.Fatal(err)
			}
			var report rtcp.TransportLayerCC
			if err := report.Unmarshal(raw); err != nil {
				t.Fatal(err)
			}
			tr.onFeedback(&report)
		}
	}
	read(121)
	feedback()
	for seq := range uint16(121) {
		if !seen[seq] {
			t.Fatalf("receiver missing RTP sequence %d", seq)
		}
	}
	tr.mu.Lock()
	loss, delivered := tr.estimator.lossShare, tr.estimator.delivered(monotonic())
	tr.mu.Unlock()
	t.Logf("receiver missing=0, packets=%d, lossShare=%.3f, deliveredShare=%.3f", len(seen), loss, delivered)
	if loss != 0 || delivered != 1 {
		t.Fatal("duplicate repairs created bogus transport loss")
	}
	// A duplicate after an idle gap must not strand the subscription between
	// its inactive and active transitions, even when the monitor misses the gap.
	layers[1].lastRTP.Store(monotonic() - 2*int64(layerIdleAfter))
	forward(1, 100, false, true)
	forward(1, 121, true, false)
	read(1)
	if !seen[121] {
		t.Fatal("fresh keyframe did not resume after an idle duplicate")
	}
}

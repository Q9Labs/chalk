package media

import (
	"testing"
	"time"

	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// A staging feedback report marked 14 new transport sequence numbers missing
// for copies of one primary RTP packet whose first copy was acknowledged.
// Replaying the publisher repair as primary SRTP makes the viewer reject it
// before TWCC, although its media sequence space has no missing packets.
func TestTWCCLoopbackDuplicateRepairs(t *testing.T) {
	received := make(chan *rtp.Packet, 256)
	pair := newPionPair(t, func(packet *rtp.Packet) { received <- packet })
	pub := &publication{session: &Session{id: "publisher", pc: pair.server}, name: "camera", kind: webrtc.RTPCodecTypeVideo, source: "camera", authority: freeAuthority()}
	tr := newTransport(&delayHistogram{}, 128<<10, nil)
	t.Cleanup(tr.close)
	track := newEgressTrack(pub, tr)
	pair.connect(t, track)
	binding := track.binding.Load()
	if binding == nil || binding.twccID == 0 {
		t.Fatal("transport-wide feedback was not negotiated")
	}
	flow := newRepairFlow(t, pub, tr, track)
	flow.sendWithDuplicateRepairs()

	viewer := &twccViewer{t: t, received: received, recorder: twcc.NewRecorder(1), seen: map[uint16]bool{}, extensionID: binding.twccID}
	viewer.read(121)
	viewer.report(tr)
	for seq := range uint16(121) {
		if !viewer.seen[seq] {
			t.Fatalf("receiver missing RTP sequence %d", seq)
		}
	}
	tr.mu.Lock()
	loss, delivered := tr.estimator.lossShare, tr.estimator.delivered(monotonic())
	tr.mu.Unlock()
	t.Logf("receiver missing=0, packets=%d, lossShare=%.3f, deliveredShare=%.3f", len(viewer.seen), loss, delivered)
	if loss != 0 || delivered != 1 {
		t.Fatal("duplicate repairs created bogus transport loss")
	}
	// A duplicate after an idle gap must not strand the subscription between
	// its inactive and active transitions, even when the monitor misses the gap.
	flow.layers[1].lastRTP.Store(monotonic() - 2*int64(layerIdleAfter))
	flow.forward(1, 100, false, true)
	flow.forward(1, 121, true, false)
	viewer.read(1)
	if !viewer.seen[121] {
		t.Fatal("fresh keyframe did not resume after an idle duplicate")
	}
}

// repairFlow drives a publication with two simulcast layers into one subscription.
type repairFlow struct {
	t      *testing.T
	pub    *publication
	sub    *subscription
	layers [2]*ingressLayer
	writer *packetWriter
	header rtp.Header
}

func newRepairFlow(t *testing.T, pub *publication, tr *transport, track *egressTrack) *repairFlow {
	sub := &subscription{pub: pub, transport: tr, track: track, request: layerRequest{ceiling: "h"}, target: 0, translator: translator{clockRate: 90000}}
	sub.interest.Store(1)
	f := &repairFlow{t: t, pub: pub, sub: sub, writer: &packetWriter{}, layers: [2]*ingressLayer{{index: 0, rid: "l"}, {index: 1, rid: "h"}}}
	for index, layer := range f.layers {
		layer.lastRTP.Store(monotonic())
		layer.history.Store(newHistory(128<<10, historySlots))
		pub.layers[index].Store(layer)
	}
	pub.subscribers.Store(&[]*subscription{sub})
	return f
}

func (f *repairFlow) forward(layer int, seq uint64, key, repaired bool) {
	p := vp8Packet(seq, uint32(seq)*3000, uint8(seq%128), uint8(seq), true, key)
	raw, err := (&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SSRC: uint32(layer + 1), SequenceNumber: uint16(seq), Timestamp: p.timestamp, Marker: true}, Payload: p.payload}).Marshal()
	if err != nil {
		f.t.Fatal(err)
	}
	f.pub.forward(f.layers[layer], raw, repaired, &f.header, f.writer)
}

// sendWithDuplicateRepairs sends 121 packets of media: layer l with one real hole that a repair
// fills, a switch to layer h, and 14 duplicate repairs of one h packet.
func (f *repairFlow) sendWithDuplicateRepairs() {
	for seq := range uint64(60) {
		if seq != 50 {
			f.forward(0, seq, seq == 0, false)
		}
	}
	f.sub.target = 1
	f.sub.interest.Store(3)
	for seq := uint64(60); seq < 80; seq++ {
		f.forward(1, seq, false, false) // The new layer cannot flow before its keyframe.
		f.forward(0, seq, false, false)
	}
	f.forward(0, 50, false, true) // A repair which fills a real hole must still flow.
	for seq := uint64(80); seq < 120; seq++ {
		f.forward(1, seq, seq == 80, false)
	}
	for range 14 {
		f.forward(1, 100, false, true)
	}
	f.forward(1, 120, false, false)
}

// twccViewer reads the packets the viewer got and reports them back as transport-wide feedback.
type twccViewer struct {
	t           *testing.T
	received    chan *rtp.Packet
	recorder    *twcc.Recorder
	seen        map[uint16]bool
	extensionID uint8
}

func (v *twccViewer) read(n int) {
	for range n {
		select {
		case packet := <-v.received:
			v.seen[packet.SequenceNumber] = true
			ext := &rtp.TransportCCExtension{}
			if err := ext.Unmarshal(packet.GetExtension(v.extensionID)); err != nil {
				v.t.Fatal(err)
			}
			v.recorder.Record(packet.SSRC, ext.TransportSequence, time.Now().UnixMicro())
		case <-time.After(5 * time.Second):
			v.t.Fatalf("packet did not arrive: received=%d", len(v.seen))
		}
	}
}

func (v *twccViewer) report(tr *transport) {
	for _, packet := range v.recorder.BuildFeedbackPacket() {
		raw, err := packet.Marshal()
		if err != nil {
			v.t.Fatal(err)
		}
		var report rtcp.TransportLayerCC
		if err := report.Unmarshal(raw); err != nil {
			v.t.Fatal(err)
		}
		tr.onFeedback(&report)
	}
}

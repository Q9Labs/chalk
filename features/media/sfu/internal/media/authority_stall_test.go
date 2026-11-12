package media

import (
	"slices"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// hookWriter records a subscriber's writes and runs a hook inside each one, the
// moment a send is stuck in Pion.
type hookWriter struct {
	sequences []uint16
	hook      func(write int)
}

func (h *hookWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	h.sequences = append(h.sequences, header.SequenceNumber)
	if h.hook != nil {
		h.hook(len(h.sequences))
	}
	return header.MarshalSize() + len(payload), nil
}

func (h *hookWriter) Write(b []byte) (int, error) { return len(b), nil }

// Every egress write checks the lease at the time it sends, not when the packet
// arrived or when its loop began, because an earlier write can stall past the lease.
func TestAWriteThatStallsPastTheLeaseStopsTheSendsAfterIt(t *testing.T) {
	// leased is the bench publication under a one-minute lease, with its two "h"
	// viewers on hook writers. lapse ends the lease at once; send forwards ring packets.
	leased := func() (viewers [2]*subscription, writers [2]*hookWriter, lapse func(), send func(...int)) {
		pub, layers, _ := benchPublication(t)
		authority := &sourceAuthority{}
		now := monotonic()
		authority.window.Store(&leaseWindow{since: now, until: now + int64(time.Minute)})
		pub.authority = authority
		layers[0].lastAsked.Store(now + int64(time.Hour)) // the test publication has no peer to ask
		subscribers := *pub.subscribers.Load()
		for index := range viewers {
			viewers[index], writers[index] = subscribers[index], &hookWriter{}
			viewers[index].track.binding.Store(&egressBinding{writer: writers[index], ssrc: uint32(100 + index), payloadType: 96})
		}
		lapse = func() {
			authority.window.Store(&leaseWindow{since: authority.window.Load().since, until: monotonic()})
		}
		packets := cameraPackets("h")
		writer := &packetWriter{}
		var header rtp.Header
		send = func(order ...int) {
			for _, n := range order {
				stamp(packets[n], n)
				pub.forward(layers[0], packets[n], false, &header, writer)
			}
		}
		return viewers, writers, lapse, send
	}
	lapseOn := func(writer *hookWriter, write int, lapse func()) {
		writer.hook = func(n int) {
			if n == write {
				lapse()
			}
		}
	}

	t.Run("live", func(t *testing.T) {
		_, writers, lapse, send := leased()
		lapseOn(writers[0], 1, lapse)
		send(0)
		if len(writers[0].sequences) != 1 || len(writers[1].sequences) != 0 {
			t.Fatalf("the next viewer got %d packets after the lease lapsed in the first viewer's write", len(writers[1].sequences))
		}
	})
	t.Run("flush", func(t *testing.T) {
		_, writers, lapse, send := leased()
		lapseOn(writers[0], 2, lapse) // the flush's first write
		send(2, 1, 0)                 // the keyframe's start arrives last, so its switch flushes 1 and 2
		if got := len(writers[0].sequences); got != 2 {
			t.Fatalf("the viewer got %d packets, want the keyframe start and the one flushed write that lapsed", got)
		}
	})
	t.Run("resend", func(t *testing.T) {
		viewers, writers, lapse, send := leased()
		send(0, 1, 2, 3, 4)
		sent := slices.Clone(writers[0].sequences)
		if len(sent) != benchPacketsPerFrame {
			t.Fatalf("the viewer got %d of %d packets", len(sent), benchPacketsPerFrame)
		}
		lapseOn(writers[0], len(sent)+1, lapse) // the first resend
		viewers[0].retransmit(&rtcp.TransportLayerNack{Nacks: rtcp.NackPairsFromSequenceNumbers(sent[:2])}, 64, &packetWriter{})
		if got := len(writers[0].sequences) - len(sent); got != 1 {
			t.Fatalf("a NACK resent %d packets, want only the one whose write lapsed", got)
		}
	})
}

func TestAPacketQueuedInThePacerWhenItsSourceIsRevokedIsNeverSent(t *testing.T) {
	t.Run("revoked", func(t *testing.T) {
		pacedPacketsOfAStoppedSource(t, func(*Node, *sourceAuthority) {}, func(authority *sourceAuthority) { authority.window.Store(closedWindow) })
	})
	// The publisher left, so the table may evict its source, and a later revoke reaches
	// only the replacement entry.
	t.Run("evicted", func(t *testing.T) {
		pacedPacketsOfAStoppedSource(t, func(n *Node, authority *sourceAuthority) {
			n.mu.Lock()
			n.evictSource(authority.key)
			n.mu.Unlock()
		}, func(*sourceAuthority) {})
	})
}

func pacedPacketsOfAStoppedSource(t *testing.T, evict func(*Node, *sourceAuthority), revoke func(*sourceAuthority)) {
	t.Helper()
	n := leaseNode(t, time.Minute)
	apply(t, n, control("alice", "camera", protocol.SourceGrant, 1))
	authority := authorityOf(t, n, testScope("alice", 1), "camera")
	pub, layers, _ := benchPublication(t)
	pub.authority = authority
	viewer := (*pub.subscribers.Load())[0]
	wire := &wireWriter{}
	viewer.track.binding.Store(&egressBinding{writer: wire, ssrc: 100, payloadType: 96, rtxSSRC: 101, rtxPayloadType: 97, twccID: 3})
	layers[0].lastAsked.Store(monotonic() + int64(time.Hour)) // the test publication has no peer to ask
	transport := viewer.transport
	transport.mu.Lock()
	transport.setRates(0) // the bench paces without bound
	transport.refill(monotonic())
	transport.tokens = -1e6 // the pacer holds everything that arrives
	transport.mu.Unlock()

	var header rtp.Header
	writer := &packetWriter{}
	for index, raw := range cameraPackets("h")[:benchPacketsPerFrame] {
		stamp(raw, index)
		pub.forward(layers[0], raw, false, &header, writer)
	}
	queued := transport.queues[classVideo]
	if queued.empty() {
		t.Fatal("no video waits in the pacer, so the test proves nothing")
	}
	first := queued.items[queued.head].packet.seq
	viewer.retransmit(&rtcp.TransportLayerNack{Nacks: rtcp.NackPairsFromSequenceNumbers([]uint16{first})}, 64, writer)
	if transport.queues[classRepair].empty() {
		t.Fatal("no RTX repair waits in the pacer, so the test proves nothing")
	}

	evict(n, authority)
	revoke(authority)
	transport.mu.Lock()
	transport.tokens = 1e9
	transport.mu.Unlock()
	transport.drainOnce()
	if sent := wire.sent(); len(sent) != 0 {
		t.Fatalf("the pacer sent %d packets of a revoked source, first %+v", len(sent), sent[0])
	}
	if transport.queuedBytes != 0 {
		t.Fatalf("%d bytes of a revoked source still wait in the pacer", transport.queuedBytes)
	}
}

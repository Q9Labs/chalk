package tests

import (
	"errors"
	"math/rand/v2"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// link emulates one peer's access link on a real UDP socket. Packets the peer
// receives wait in a drop-tail queue that drains at the link rate and then
// take a fixed delay, like a constrained downlink; either direction can lose
// packets at random. It is netem in user space, so the harness runs anywhere.
type link struct {
	conn  net.PacketConn
	ready chan datagram

	mu         sync.Mutex
	rate       float64 // bits/s; 0 is unconstrained
	queueBytes int
	delay      time.Duration
	inLoss     float64
	outLoss    float64
	random     *rand.Rand
	busyUntil  time.Time
	pending    []datagram
	wake       chan struct{}
	inDropped  int
	outDropped int
}

type datagram struct {
	payload []byte
	from    net.Addr
	release time.Time
}

func newLink(t *testing.T) *link {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l := &link{conn: conn, ready: make(chan datagram, 4096), wake: make(chan struct{}, 1), random: rand.New(rand.NewPCG(1, 2))}
	var workers sync.WaitGroup
	workers.Go(l.receive)
	workers.Go(l.release)
	t.Cleanup(func() {
		_ = conn.Close()
		workers.Wait()
	})
	return l
}

// shape sets the downlink rate, its queue and delay, and the loss each way.
func (l *link) shape(rate float64, queueBytes int, delay time.Duration, inLoss, outLoss float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rate, l.queueBytes, l.delay, l.inLoss, l.outLoss = rate, queueBytes, delay, inLoss, outLoss
}

func (l *link) dropped() (in, out int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.inDropped, l.outDropped
}

func (l *link) receive() {
	defer close(l.wake)
	buffer := make([]byte, 1500)
	for {
		n, from, err := l.conn.ReadFrom(buffer)
		if err != nil {
			return
		}
		now := time.Now()
		l.mu.Lock()
		if l.inLoss > 0 && l.random.Float64() < l.inLoss {
			l.inDropped++
			l.mu.Unlock()
			continue
		}
		release := now
		if l.rate > 0 {
			backlog := 0.0
			if l.busyUntil.After(now) {
				backlog = l.rate / 8 * l.busyUntil.Sub(now).Seconds()
			}
			if int(backlog)+n > l.queueBytes {
				l.inDropped++
				l.mu.Unlock()
				continue
			}
			start := now
			if l.busyUntil.After(now) {
				start = l.busyUntil
			}
			l.busyUntil = start.Add(time.Duration(float64(n*8) / l.rate * float64(time.Second)))
			release = l.busyUntil
		}
		l.pending = append(l.pending, datagram{payload: append([]byte(nil), buffer[:n]...), from: from, release: release.Add(l.delay)})
		l.mu.Unlock()
		select {
		case l.wake <- struct{}{}:
		default:
		}
	}
}

func (l *link) release() {
	defer close(l.ready)
	for {
		l.mu.Lock()
		var next *datagram
		if len(l.pending) > 0 {
			next = &l.pending[0]
		}
		l.mu.Unlock()
		if next == nil {
			if _, ok := <-l.wake; !ok {
				return
			}
			continue
		}
		if wait := time.Until(next.release); wait > 0 {
			time.Sleep(wait)
		}
		l.mu.Lock()
		packet := l.pending[0]
		l.pending = l.pending[1:]
		l.mu.Unlock()
		l.ready <- packet
	}
}

func (l *link) ReadFrom(p []byte) (int, net.Addr, error) {
	packet, ok := <-l.ready
	if !ok {
		return 0, nil, net.ErrClosed
	}
	return copy(p, packet.payload), packet.from, nil
}

func (l *link) WriteTo(p []byte, addr net.Addr) (int, error) {
	l.mu.Lock()
	drop := l.outLoss > 0 && l.random.Float64() < l.outLoss
	if drop {
		l.outDropped++
	}
	l.mu.Unlock()
	if drop {
		return len(p), nil
	}
	return l.conn.WriteTo(p, addr)
}

func (l *link) Close() error                       { return l.conn.Close() }
func (l *link) LocalAddr() net.Addr                { return l.conn.LocalAddr() }
func (l *link) SetDeadline(time.Time) error        { return nil }
func (l *link) SetReadDeadline(time.Time) error    { return nil }
func (l *link) SetWriteDeadline(t time.Time) error { return l.conn.SetWriteDeadline(t) }

var _ net.PacketConn = (*link)(nil)

// newMediaPeer is a peer with Pion's default interceptors, as a browser has
// them: NACK generation and response, RTCP reports and transport-wide
// feedback. Its media goes through the link. browserRTX names its simulcast
// RTX by the repaired RID, as a browser does.
func newMediaPeer(t *testing.T, through *link, browserRTX bool) *peer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	registry := &interceptor.Registry{}
	if browserRTX {
		// Registered first, so it sees the NACK responder's RTX on its way out.
		registry.Add(browserRTXFactory{})
	}
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: through})
	settings.SetICEUDPMux(mux)
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := pc.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Logf("close peer: %v", err)
		}
		_ = mux.Close()
	})
	return &peer{pc: pc}
}

// browserRTXFactory makes a Pion publisher name its simulcast RTX the way a
// browser does. Pion's NACK responder copies the layer's RID onto RTX packets;
// RFC 8852 and libwebrtc use the repaired RID there, so the SFU can tell a
// repair stream from the layer.
type browserRTXFactory struct{}

func (browserRTXFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &browserRTX{}, nil
}

type browserRTX struct{ interceptor.NoOp }

func (*browserRTX) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	var rid, repaired uint8
	for _, extension := range info.RTPHeaderExtensions {
		switch extension.URI {
		case sdp.SDESRTPStreamIDURI:
			rid = uint8(extension.ID)
		case sdp.SDESRepairRTPStreamIDURI:
			repaired = uint8(extension.ID)
		}
	}
	if info.PayloadTypeRetransmission == 0 || rid == 0 || repaired == 0 {
		return writer
	}
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		value := header.GetExtension(rid)
		if header.PayloadType != info.PayloadTypeRetransmission || value == nil {
			return writer.Write(header, payload, attributes)
		}
		renamed := header.Clone()
		renamed.DelExtension(rid)
		if err := renamed.SetExtension(repaired, value); err != nil {
			return 0, err
		}
		return writer.Write(&renamed, payload, attributes)
	})
}

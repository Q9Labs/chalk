//go:build linux

package media

import (
	"encoding/binary"
	"net"
	"net/netip"
	"testing"
	"time"
)

func listenLoopback(t testing.TB) *net.UDPConn {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func newTestBatchConn(t testing.TB, segmentation bool) *batchConn {
	t.Helper()
	conn := newMediaConn(listenLoopback(t))
	batch, ok := conn.(*batchConn)
	if !ok {
		t.Fatalf("newMediaConn returned %T for an IPv4 socket", conn)
	}
	t.Cleanup(func() { _ = batch.Close() })
	batch.gso = batch.gso && segmentation
	batch.markVideo(videoSSRC, true)
	return batch
}

// datagram is peer, sequence number, then filler up to size bytes.
func datagram(peer, seq uint32, size int) []byte {
	b := make([]byte, size)
	binary.BigEndian.PutUint32(b[0:], peer)
	binary.BigEndian.PutUint32(b[4:], seq)
	return b
}

func queueOf(peer netip.AddrPort, sizes ...int) []*queued {
	out := make([]*queued, len(sizes))
	for i, size := range sizes {
		out[i] = &queued{addr: peer, n: size}
	}
	return out
}

// A train the kernel refuses is resent as single datagrams, so no datagram is lost to it.
func TestBatchConnResendsARefusedTrainOneByOne(t *testing.T) {
	conn := newTestBatchConn(t, true)
	peer := listenLoopback(t)
	addr := peer.LocalAddr().(*net.UDPAddr).AddrPort()
	entries := queueOf(addr, 1100, 1100, 300)
	for i := range entries {
		copy(entries[i].buf[:], datagram(0, uint32(i), entries[i].n))
	}
	messages := conn.plan(entries)
	if messages != 1 {
		t.Fatalf("%d messages, want one train", messages)
	}
	conn.sendEach(&conn.out[0])
	buf := make([]byte, 2048)
	for i, size := range []int{1100, 1100, 300} {
		_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, _, err := peer.ReadFromUDPAddrPort(buf)
		if err != nil || n != size || binary.BigEndian.Uint32(buf[4:]) != uint32(i) {
			t.Fatalf("datagram %d: %d bytes seq %d, %v", i, n, binary.BigEndian.Uint32(buf[4:]), err)
		}
	}
}

func benchmarkSend(b *testing.B, mode string) {
	sink := listenLoopback(b)
	_ = sink.SetReadBuffer(8 << 20)
	go func() {
		buf := make([]byte, 2048)
		for {
			if _, _, err := sink.ReadFromUDPAddrPort(buf); err != nil {
				return
			}
		}
	}()
	target := sink.LocalAddr().(*net.UDPAddr).AddrPort()
	payload := make([]byte, 1100)
	var send func([]byte)
	var dropped func() int64
	switch mode {
	case "plain":
		conn := listenLoopback(b)
		send = func(p []byte) { _, _ = conn.WriteToUDPAddrPort(p, target) }
	default:
		conn := newTestBatchConn(b, mode == "segmented")
		send = func(p []byte) { _, _ = conn.WriteToAddrPort(p, target) }
		dropped = func() int64 { return conn.droppedAudio.Load() + conn.droppedVideo.Load() }
	}
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for i := range b.N {
		send(payload)
		if i%8 == 7 {
			time.Sleep(time.Microsecond)
		}
	}
	if dropped != nil {
		// The loop outruns the socket, so the share dropped says how much of the speed is waiting avoided.
		b.ReportMetric(float64(dropped())/float64(b.N), "dropped/op")
	}
}

func BenchmarkSendPlain(b *testing.B)     { benchmarkSend(b, "plain") }
func BenchmarkSendBatched(b *testing.B)   { benchmarkSend(b, "batched") }
func BenchmarkSendSegmented(b *testing.B) { benchmarkSend(b, "segmented") }

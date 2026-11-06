//go:build linux

package media

import (
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"

	"golang.org/x/sys/unix"
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
	return batch
}

// datagram is peer, sequence number, then filler up to size bytes.
func datagram(peer, seq uint32, size int) []byte {
	b := make([]byte, size)
	binary.BigEndian.PutUint32(b[0:], peer)
	binary.BigEndian.PutUint32(b[4:], seq)
	return b
}

func TestControlMessageSpaceMatchesQueueStorage(t *testing.T) {
	var control [batchRing][unix.SizeofCmsghdr + 8]byte
	if got := unix.CmsgSpace(2); got > len(control[0]) {
		t.Fatalf("a UDP_SEGMENT control message needs %d bytes, the queue reserves %d", got, len(control[0]))
	}
}

// Each peer receives every datagram, in the order they were written, whether or not
// the writer sends them as segmented trains.
func TestBatchConnDeliversEveryDatagramInOrderPerPeer(t *testing.T) {
	for _, segmentation := range []bool{false, true} {
		name := "plain"
		if segmentation {
			name = "segmented"
		}
		t.Run(name, func(t *testing.T) {
			conn := newTestBatchConn(t, segmentation)
			peers := make([]*net.UDPConn, 3)
			for i := range peers {
				peers[i] = listenLoopback(t)
				_ = peers[i].SetReadBuffer(4 << 20)
			}
			sent := make([][]int, len(peers)) // sizes per peer in order
			var seq [3]uint32
			for frame := range 300 {
				peer := frame % len(peers)
				// A frame is equal-size packets and a shorter last one; some frames are one packet.
				packets := 1 + frame%9
				for p := range packets {
					size := 1100
					if p == packets-1 && packets > 1 {
						size = 200 + frame%700
					}
					if _, err := conn.WriteToAddrPort(datagram(uint32(peer), seq[peer], size), peers[peer].LocalAddr().(*net.UDPAddr).AddrPort()); err != nil {
						t.Fatal(err)
					}
					sent[peer] = append(sent[peer], size)
					seq[peer]++
				}
			}
			buf := make([]byte, 2048)
			for i, peer := range peers {
				for want, size := range sent[i] {
					_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
					n, _, err := peer.ReadFromUDPAddrPort(buf)
					if err != nil {
						t.Fatalf("peer %d datagram %d of %d: %v", i, want, len(sent[i]), err)
					}
					if n != size || binary.BigEndian.Uint32(buf[0:]) != uint32(i) || binary.BigEndian.Uint32(buf[4:]) != uint32(want) {
						t.Fatalf("peer %d datagram %d: got %d bytes peer %d seq %d, want %d bytes seq %d", i, want, n,
							binary.BigEndian.Uint32(buf[0:]), binary.BigEndian.Uint32(buf[4:]), size, want)
					}
				}
			}
			if conn.refused.Load() != 0 {
				t.Fatalf("the kernel refused %d datagrams", conn.refused.Load())
			}
		})
	}
}

func TestBatchConnPlansOneTrainPerRunOfEqualSizeDatagrams(t *testing.T) {
	a := netip.MustParseAddrPort("127.0.0.1:4001")
	b := netip.MustParseAddrPort("127.0.0.1:4002")
	cases := []struct {
		name  string
		gso   bool
		input []queued
		runs  []int // datagrams per message, in message order
	}{
		{"a frame is one train", true, queueOf(a, 1100, 1100, 1100, 300), []int{4}},
		{"peers interleaved by fan-out each get a train", true, append(append(queueOf(a, 1100), queueOf(b, 1100)...), append(queueOf(a, 1100), queueOf(b, 400)...)...), []int{2, 2}},
		{"a short datagram ends a train", true, queueOf(a, 1100, 1100, 300, 1100), []int{3, 1}},
		{"a longer datagram starts a new train", true, queueOf(a, 300, 1100), []int{1, 1}},
		{"no segmentation sends each datagram", false, queueOf(a, 1100, 1100, 300), []int{1, 1, 1}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			conn := &batchConn{gso: test.gso}
			messages := conn.plan(test.input)
			if messages != len(test.runs) {
				t.Fatalf("%d messages, want %d", messages, len(test.runs))
			}
			for i, want := range test.runs {
				if got := int(conn.out[i].Hdr.Iovlen); got != want {
					t.Errorf("message %d carries %d datagrams, want %d", i, got, want)
				}
				if (want > 1) != (conn.out[i].Hdr.Controllen != 0) {
					t.Errorf("message %d: segment control message %d bytes for %d datagrams", i, conn.out[i].Hdr.Controllen, want)
				}
			}
		})
	}
}

func TestBatchConnKeepsTrainsUnderTheGSOPayloadLimit(t *testing.T) {
	a := netip.MustParseAddrPort("127.0.0.1:4001")
	conn := &batchConn{gso: true}
	sizes := make([]int, gsoSegments)
	for i := range sizes {
		sizes[i] = 1100
	}
	messages := conn.plan(queueOf(a, sizes...))
	datagrams := 0
	for i := range messages {
		count := int(conn.out[i].Hdr.Iovlen)
		if count*1100 > gsoPayloadMax {
			t.Errorf("message %d carries %d bytes, over the %d limit", i, count*1100, gsoPayloadMax)
		}
		datagrams += count
	}
	if messages < 2 || datagrams != gsoSegments {
		t.Fatalf("%d messages carrying %d datagrams, want a split of %d", messages, datagrams, gsoSegments)
	}
}

func queueOf(peer netip.AddrPort, sizes ...int) []queued {
	out := make([]queued, len(sizes))
	for i, size := range sizes {
		out[i].addr, out[i].n = peer, size
	}
	return out
}

func TestBatchConnReadsABurstWithSourceAddresses(t *testing.T) {
	conn := newTestBatchConn(t, true)
	senders := []*net.UDPConn{listenLoopback(t), listenLoopback(t)}
	target := conn.LocalAddr().(*net.UDPAddr)
	const total = 100
	for i := range total {
		sender := senders[i%2]
		if _, err := sender.WriteToUDP(datagram(uint32(i%2), uint32(i), 100+i), target); err != nil {
			t.Fatal(err)
		}
	}
	buf := make([]byte, 2048)
	for i := range total {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, from, err := conn.ReadFromAddrPort(buf)
		if err != nil {
			t.Fatalf("datagram %d: %v", i, err)
		}
		want := senders[i%2].LocalAddr().(*net.UDPAddr).AddrPort()
		if n != 100+i || from != want || binary.BigEndian.Uint32(buf[4:]) != uint32(i) {
			t.Fatalf("datagram %d: %d bytes from %v seq %d, want %d bytes from %v", i, n, from, binary.BigEndian.Uint32(buf[4:]), 100+i, want)
		}
	}
}

func TestBatchConnDropsAndCountsTruncatedDatagrams(t *testing.T) {
	conn := newTestBatchConn(t, true)
	sender := listenLoopback(t)
	target := conn.LocalAddr().(*net.UDPAddr)
	for _, size := range []int{receiveMax + 100, 300} {
		if _, err := sender.WriteToUDP(datagram(0, uint32(size), size), target); err != nil {
			t.Fatal(err)
		}
	}
	buf := make([]byte, 2048)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, _, err := conn.ReadFromAddrPort(buf)
	if err != nil || n != 300 {
		t.Fatalf("read %d bytes, %v, want the 300-byte datagram after the oversized one was dropped", n, err)
	}
	if _, truncated := conn.counters(); truncated != 1 {
		t.Fatalf("%d truncated datagrams counted, want 1", truncated)
	}
}

func TestBatchConnReadFailsAfterClose(t *testing.T) {
	conn := newTestBatchConn(t, true)
	errs := make(chan error, 1)
	go func() {
		_, _, err := conn.ReadFromAddrPort(make([]byte, 2048))
		errs <- err
	}()
	time.Sleep(50 * time.Millisecond)
	_ = conn.Close()
	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("the read returned no error after Close")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a blocked read did not return after Close")
	}
	select {
	case <-conn.done:
	default:
		t.Fatal("Close left the writer running")
	}
}

// A burst larger than the queue still arrives complete and in order.
// A caller that finds the queue full waits without holding mu, which the writer needs to
// take the queue, and Close wakes it.
func TestBatchConnWaitsForQueueSpaceWithoutHoldingTheLock(t *testing.T) {
	conn := newTestBatchConn(t, true)
	peer := listenLoopback(t)
	addr := peer.LocalAddr().(*net.UDPAddr).AddrPort()
	conn.mu.Lock()
	conn.count = batchRing
	conn.mu.Unlock()

	written := make(chan error, 1)
	go func() {
		_, err := conn.WriteToAddrPort(datagram(0, 1, 300), addr)
		written <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if conn.mu.TryLock() { // a waiter that held mu would make this fail forever
			conn.mu.Unlock()
			select {
			case err := <-written:
				t.Fatalf("a write returned %v while the queue was full", err)
			case <-time.After(50 * time.Millisecond):
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the waiting write holds mu")
		}
		time.Sleep(time.Millisecond)
	}

	conn.mu.Lock()
	conn.count = 0
	conn.space.Broadcast()
	conn.mu.Unlock()
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2048)
	_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	if n, _, err := peer.ReadFromUDPAddrPort(buf); err != nil || n != 300 {
		t.Fatalf("queued datagram: %d bytes, %v", n, err)
	}

	conn.mu.Lock()
	conn.count = batchRing
	conn.mu.Unlock()
	go func() {
		_, err := conn.WriteToAddrPort(datagram(0, 2, 300), addr)
		written <- err
	}()
	time.Sleep(50 * time.Millisecond)
	_ = conn.Close()
	select {
	case err := <-written:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("a write woken by Close returned %v, want net.ErrClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not wake the waiting write")
	}
}

func TestBatchConnKeepsOrderWhenTheQueueOverflows(t *testing.T) {
	conn := newTestBatchConn(t, true)
	peer := listenLoopback(t)
	_ = peer.SetReadBuffer(4 << 20)
	addr := peer.LocalAddr().(*net.UDPAddr).AddrPort()
	const total = 3*batchRing + 5
	// The peer reads while the writes go on: the whole run would overflow its receive buffer.
	failed := make(chan error, 1)
	go func() {
		for i := range total {
			if _, err := conn.WriteToAddrPort(datagram(0, uint32(i), 300+i%7), addr); err != nil {
				failed <- err
				return
			}
		}
		failed <- nil
	}()
	defer func() {
		if err := <-failed; err != nil {
			t.Error(err)
		}
	}()
	buf := make([]byte, 2048)
	for i := range total {
		_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, _, err := peer.ReadFromUDPAddrPort(buf)
		if err != nil || n != 300+i%7 || binary.BigEndian.Uint32(buf[4:]) != uint32(i) {
			t.Fatalf("datagram %d: %d bytes seq %d, %v", i, n, binary.BigEndian.Uint32(buf[4:]), err)
		}
	}
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
	switch mode {
	case "plain":
		conn := listenLoopback(b)
		send = func(p []byte) { _, _ = conn.WriteToUDPAddrPort(p, target) }
	default:
		conn := newTestBatchConn(b, mode == "segmented")
		send = func(p []byte) { _, _ = conn.WriteToAddrPort(p, target) }
	}
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for i := range b.N {
		send(payload)
		if i%8 == 7 {
			time.Sleep(time.Microsecond)
		}
	}
}

func BenchmarkSendPlain(b *testing.B)     { benchmarkSend(b, "plain") }
func BenchmarkSendBatched(b *testing.B)   { benchmarkSend(b, "batched") }
func BenchmarkSendSegmented(b *testing.B) { benchmarkSend(b, "segmented") }

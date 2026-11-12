//go:build linux

package media

import (
	"encoding/binary"
	"net"
	"net/netip"
	"slices"
	"sync"
	"testing"
	"time"
)

// The SSRCs of the video and audio streams a test conn sends; newTestBatchConn marks the video ones.
const (
	videoSSRC    = 0xaaaa0001
	videoRTXSSRC = 0xaaaa0002
	audioSSRC    = 0xbbbb0001
)

// rtpDatagram is an RTP-looking datagram: the version bits, the payload type, a sequence number in
// bytes 4 to 7 as datagram() has it, the SSRC in bytes 8 to 11, then filler up to size bytes.
func rtpDatagram(payloadType byte, ssrc, seq uint32, size int) []byte {
	b := datagram(0, seq, size)
	b[0], b[1] = 0x80, payloadType
	binary.BigEndian.PutUint32(b[8:], ssrc)
	return b
}

// Firefox negotiates VP8 as 120 and RTX as 124, which are not the types the node offers, so the
// class must follow the SSRC the node marked and never the payload type.
func TestIsVideoReadsTheSSRCOfAnSRTPPacket(t *testing.T) {
	conn := newTestBatchConn(t, true)
	conn.markVideo(videoRTXSSRC, true)
	for name, test := range map[string]struct {
		packet []byte
		want   bool
	}{
		"VP8":                   {rtpDatagram(vp8PayloadType, videoSSRC, 1, 100), true},
		"VP8 with marker":       {rtpDatagram(vp8PayloadType|0x80, videoSSRC, 1, 100), true},
		"VP8 as Firefox has it": {rtpDatagram(120, videoSSRC, 1, 100), true},
		"VP8 on a low type":     {rtpDatagram(45, videoSSRC, 1, 100), true},
		"RTX as Firefox has it": {rtpDatagram(124, videoRTXSSRC, 1, 100), true},
		"Opus":                  {rtpDatagram(opusPayloadType, audioSSRC, 1, 100), false},
		"Opus on a video type":  {rtpDatagram(vp8PayloadType, audioSSRC, 1, 100), false},
		"RTCP receiver report":  {rtpDatagram(201, videoSSRC, 1, 100), false},
		"DTLS":                  {append([]byte{22, 254, 253}, make([]byte, 40)...), false},
		"STUN":                  {append([]byte{0, 1}, make([]byte, 40)...), false},
		"too short":             {[]byte{0x80, vp8PayloadType}, false},
	} {
		conn.mu.Lock()
		got := conn.isVideo(test.packet)
		conn.mu.Unlock()
		if got != test.want {
			t.Errorf("%s: isVideo = %v, want %v", name, got, test.want)
		}
	}
	conn.markVideo(videoSSRC, false)
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.isVideo(rtpDatagram(vp8PayloadType, videoSSRC, 1, 100)) {
		t.Error("a stream that was unmarked is still video")
	}
}

// stallWriter holds the writer before its next send until the returned release is called, and
// writes one audio datagram to wake it, so every later write meets a stalled socket.
func stallWriter(t *testing.T, conn *batchConn, to netip.AddrPort) (release func()) {
	t.Helper()
	held, gate := make(chan struct{}, 1), make(chan struct{})
	conn.stalled = func() {
		select {
		case held <- struct{}{}:
		default:
		}
		<-gate
	}
	if _, err := conn.WriteToAddrPort(rtpDatagram(opusPayloadType, audioSSRC, 0, 200), to); err != nil {
		t.Fatal(err)
	}
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("the writer never took the first datagram")
	}
	var once sync.Once
	release = func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	return release
}

type arrival struct {
	video bool
	seq   uint32
}

// listen collects what a peer receives until it has been quiet for 300 ms. A stalled writer sends
// nothing for a while, so the wait for the first datagram is longer.
func listen(peer *net.UDPConn) <-chan []arrival {
	out := make(chan []arrival, 1)
	go func() {
		var got []arrival
		buf := make([]byte, 2048)
		for quiet := 5 * time.Second; ; quiet = 300 * time.Millisecond {
			_ = peer.SetReadDeadline(time.Now().Add(quiet))
			_, _, err := peer.ReadFromUDPAddrPort(buf)
			if err != nil {
				out <- got
				return
			}
			got = append(got, arrival{binary.BigEndian.Uint32(buf[8:]) == videoSSRC, binary.BigEndian.Uint32(buf[4:])})
		}
	}()
	return out
}

// A stalled socket must not stop a forwarder. Audio forwarders keep their 20 ms cadence while a
// video flood overruns the stalled writer, the flood's oldest datagrams are dropped and counted,
// and when the socket moves again every audio datagram arrives, in order, ahead of the video.
func TestStalledSocketNeverBlocksAForwarderAndKeepsAudio(t *testing.T) {
	const (
		receivers   = 6
		audioFrames = 40
		floodVideo  = 3 * videoRing
	)
	conn := newTestBatchConn(t, true)
	peers := make([]*net.UDPConn, receivers)
	addrs := make([]netip.AddrPort, receivers)
	arrivals := make([]<-chan []arrival, receivers)
	for i := range peers {
		peers[i] = listenLoopback(t)
		_ = peers[i].SetReadBuffer(8 << 20)
		addrs[i] = peers[i].LocalAddr().(*net.UDPAddr).AddrPort()
		arrivals[i] = listen(peers[i])
	}
	release := stallWriter(t, conn, addrs[0])
	// A writer that waits for the socket would wait until here, so the test ends instead of hanging.
	time.AfterFunc(1500*time.Millisecond, release)

	slowest := floodStalledSocket(t, conn, addrs, audioFrames, floodVideo)
	// The socket was stalled for the whole run, so a write that waited for it would have waited here.
	if slowest > 100*time.Millisecond {
		t.Fatalf("a forwarder waited %s for the stalled socket", slowest)
	}
	release()

	droppedAudio, droppedVideo := conn.droppedAudio.Load(), conn.droppedVideo.Load()
	if droppedAudio != 0 || droppedVideo != floodVideo-videoRing {
		t.Fatalf("dropped %d audio and %d video datagrams, want 0 and %d", droppedAudio, droppedVideo, floodVideo-videoRing)
	}
	delivered := 0
	for i, channel := range arrivals {
		delivered += checkReceiverArrivals(t, i, <-channel, audioFrames, floodVideo)
	}
	if delivered != videoRing {
		t.Errorf("%d video datagrams delivered, want the newest %d", delivered, videoRing)
	}
}

// floodStalledSocket writes audioFrames audio datagrams to every receiver on a 20 ms cadence and
// floodVideo video datagrams across them, all at once, and returns the slowest single write.
func floodStalledSocket(t *testing.T, conn *batchConn, addrs []netip.AddrPort, audioFrames, floodVideo int) time.Duration {
	var mu sync.Mutex
	var slowest time.Duration
	write := func(b []byte, to netip.AddrPort) {
		start := time.Now()
		if _, err := conn.WriteToAddrPort(b, to); err != nil {
			t.Error(err)
		}
		mu.Lock()
		slowest = max(slowest, time.Since(start))
		mu.Unlock()
	}
	var forwarders sync.WaitGroup
	for i := range addrs {
		forwarders.Go(func() {
			tick := time.NewTicker(20 * time.Millisecond)
			defer tick.Stop()
			for frame := 1; frame <= audioFrames; frame++ {
				<-tick.C
				write(rtpDatagram(opusPayloadType, audioSSRC, uint32(frame), 200), addrs[i])
			}
		})
	}
	forwarders.Go(func() {
		for seq := range floodVideo {
			write(rtpDatagram(vp8PayloadType, videoSSRC, uint32(seq), 1100), addrs[seq%len(addrs)])
		}
	})
	forwarders.Wait()
	return slowest
}

// checkReceiverArrivals checks one receiver's datagrams: all audio in order, video in order and
// from the newest the ring keeps, and no audio behind video in a flush. It returns the video count.
func checkReceiverArrivals(t *testing.T, receiver int, got []arrival, audioFrames, floodVideo int) int {
	var audio, video []uint32
	for _, a := range got {
		if a.video {
			video = append(video, a.seq)
		} else {
			audio = append(audio, a.seq)
		}
	}
	if receiver == 0 {
		audio = audio[1:] // the datagram that woke the writer
	}
	if len(audio) != audioFrames || !slices.IsSorted(audio) {
		t.Errorf("receiver %d got %d audio datagrams (sorted %v), want all %d in order", receiver, len(audio), slices.IsSorted(audio), audioFrames)
	}
	if !slices.IsSorted(video) {
		t.Errorf("receiver %d got its video out of order", receiver)
	}
	for _, seq := range video {
		if seq < uint32(floodVideo-videoRing) {
			t.Errorf("receiver %d got video %d, which is older than the %d newest the ring keeps", receiver, seq, videoRing)
		}
	}
	if first := slices.IndexFunc(got, func(a arrival) bool { return a.video }); first >= 0 && slices.ContainsFunc(got[first:], func(a arrival) bool { return !a.video }) {
		t.Errorf("receiver %d got audio after video in the same flush", receiver)
	}
	return len(video)
}

// A full audio ring drops its oldest datagram for the newest and counts it as audio.
func TestFullAudioRingDropsItsOldestAndCountsIt(t *testing.T) {
	conn := newTestBatchConn(t, true)
	peer := listenLoopback(t)
	_ = peer.SetReadBuffer(8 << 20)
	addr := peer.LocalAddr().(*net.UDPAddr).AddrPort()
	arrivals := listen(peer)
	release := stallWriter(t, conn, addr)
	const extra = 10
	for seq := 1; seq <= audioRing+extra; seq++ {
		if _, err := conn.WriteToAddrPort(rtpDatagram(opusPayloadType, audioSSRC, uint32(seq), 200), addr); err != nil {
			t.Fatal(err)
		}
	}
	release()
	if audio, video := conn.droppedAudio.Load(), conn.droppedVideo.Load(); audio != extra || video != 0 {
		t.Fatalf("dropped %d audio and %d video datagrams, want %d and 0", audio, video, extra)
	}
	got := <-arrivals
	if len(got) != 1+audioRing || got[1].seq != extra+1 || got[len(got)-1].seq != audioRing+extra {
		t.Fatalf("%d datagrams arrived from seq %d to %d, want the newest %d", len(got), got[1].seq, got[len(got)-1].seq, audioRing)
	}
}

// plan sorts a flush by peer, so audio and video must leave in flushes of their own: one peer's
// video, queued before another peer's audio, must not leave first. One wildcard socket receives
// for both addresses, so the order it reads is the order the node sent.
func TestAudioLeavesBeforeAnotherPeersVideo(t *testing.T) {
	conn := newTestBatchConn(t, true)
	sink, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sink.Close() })
	port := uint16(sink.LocalAddr().(*net.UDPAddr).Port)
	low := netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port)
	high := netip.AddrPortFrom(netip.MustParseAddr("127.0.0.2"), port)
	release := stallWriter(t, conn, low)
	if _, err := conn.WriteToAddrPort(rtpDatagram(vp8PayloadType, videoSSRC, 1, 200), low); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.WriteToAddrPort(rtpDatagram(opusPayloadType, audioSSRC, 2, 200), high); err != nil {
		t.Fatal(err)
	}
	release()
	var order []uint32
	buf := make([]byte, 2048)
	for range 3 {
		_ = sink.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, _, err := sink.ReadFromUDPAddrPort(buf); err != nil {
			t.Fatal(err)
		}
		order = append(order, binary.BigEndian.Uint32(buf[4:]))
	}
	if want := []uint32{0, 2, 1}; !slices.Equal(order, want) {
		t.Fatalf("datagrams arrived in order %v, want %v: the first peer's video left before the second peer's audio", order, want)
	}
}

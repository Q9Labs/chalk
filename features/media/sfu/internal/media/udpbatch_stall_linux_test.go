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

// rtpDatagram is an RTP-looking datagram of the given payload type: the version bits, the type,
// a sequence number in bytes 4 to 7 as datagram() has it, then filler up to size bytes.
func rtpDatagram(payloadType byte, seq uint32, size int) []byte {
	b := datagram(0, seq, size)
	b[0], b[1] = 0x80, payloadType
	return b
}

func TestIsVideoReadsTheRTPPayloadTypeOfAnSRTPPacket(t *testing.T) {
	for name, test := range map[string]struct {
		packet []byte
		want   bool
	}{
		"VP8":                  {rtpDatagram(vp8PayloadType, 1, 100), true},
		"VP8 with marker":      {rtpDatagram(vp8PayloadType|0x80, 1, 100), true},
		"RTX":                  {rtpDatagram(rtxPayloadType, 1, 100), true},
		"Opus":                 {rtpDatagram(opusPayloadType, 1, 100), false},
		"RTCP receiver report": {rtpDatagram(201, 1, 100), false},
		"DTLS":                 {append([]byte{22, 254, 253}, make([]byte, 40)...), false},
		"STUN":                 {append([]byte{0, 1}, make([]byte, 40)...), false},
		"too short":            {[]byte{0x80, vp8PayloadType}, false},
	} {
		if got := isVideo(test.packet); got != test.want {
			t.Errorf("%s: isVideo = %v, want %v", name, got, test.want)
		}
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
	if _, err := conn.WriteToAddrPort(rtpDatagram(opusPayloadType, 0, 200), to); err != nil {
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
			n, _, err := peer.ReadFromUDPAddrPort(buf)
			if err != nil {
				out <- got
				return
			}
			got = append(got, arrival{isVideo(buf[:n]), binary.BigEndian.Uint32(buf[4:])})
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
				write(rtpDatagram(opusPayloadType, uint32(frame), 200), addrs[i])
			}
		})
	}
	forwarders.Go(func() {
		for seq := range floodVideo {
			write(rtpDatagram(vp8PayloadType, uint32(seq), 1100), addrs[seq%receivers])
		}
	})
	forwarders.Wait()
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
		got := <-channel
		var audio, video []uint32
		for _, a := range got {
			if a.video {
				video = append(video, a.seq)
			} else {
				audio = append(audio, a.seq)
			}
		}
		if i == 0 {
			audio = audio[1:] // the datagram that woke the writer
		}
		if len(audio) != audioFrames || !slices.IsSorted(audio) {
			t.Errorf("receiver %d got %d audio datagrams (sorted %v), want all %d in order", i, len(audio), slices.IsSorted(audio), audioFrames)
		}
		if !slices.IsSorted(video) {
			t.Errorf("receiver %d got its video out of order", i)
		}
		for _, seq := range video {
			if seq < floodVideo-videoRing {
				t.Errorf("receiver %d got video %d, which is older than the %d newest the ring keeps", i, seq, videoRing)
			}
		}
		delivered += len(video)
		if first := slices.IndexFunc(got, func(a arrival) bool { return a.video }); first >= 0 && slices.ContainsFunc(got[first:], func(a arrival) bool { return !a.video }) {
			t.Errorf("receiver %d got audio after video in the same flush", i)
		}
	}
	if delivered != videoRing {
		t.Errorf("%d video datagrams delivered, want the newest %d", delivered, videoRing)
	}
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
		if _, err := conn.WriteToAddrPort(rtpDatagram(opusPayloadType, uint32(seq), 200), addr); err != nil {
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

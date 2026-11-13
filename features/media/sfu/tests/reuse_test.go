package tests

import (
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// stream is one SSRC a viewer received: which section carried it, its codec, and which publisher's
// packets arrived on it.
type stream struct {
	mid         string
	kind        webrtc.RTPCodecType
	mime        string
	payloadType uint8
	tags        map[byte]int
	count       int
	reports     int    // RTCP sender reports received on the stream
	packets     []mark // the stream's packets in arrival order, up to markLimit
}

// mark is the header of one received packet.
type mark struct {
	seq uint16
	ts  uint32
	at  time.Time
}

const markLimit = 20000

// viewer is one subscriber peer that stays connected while it pulls and closes tracks.
type viewer struct {
	t       *testing.T
	svc     *service
	conn    string
	scope   protocol.Scope
	peer    *peer
	mu      sync.Mutex
	streams map[webrtc.SSRC]*stream
}

func newViewer(t *testing.T, svc *service, conn string, scope protocol.Scope) *viewer {
	v := &viewer{t: t, svc: svc, conn: conn, scope: scope, peer: newPeer(t), streams: map[webrtc.SSRC]*stream{}}
	v.peer.pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		mid := ""
		for _, transceiver := range v.peer.pc.GetTransceivers() {
			if transceiver.Receiver() == receiver {
				mid = transceiver.Mid()
			}
		}
		// A reused section keeps its SSRC and may fire the track event again: one stream per SSRC.
		v.mu.Lock()
		s := v.streams[remote.SSRC()]
		if s == nil {
			s = &stream{mid: mid, kind: remote.Kind(), mime: remote.Codec().MimeType, payloadType: uint8(remote.PayloadType()), tags: map[byte]int{}}
			v.streams[remote.SSRC()] = s
		}
		v.mu.Unlock()
		go func() {
			for {
				packets, _, err := receiver.ReadRTCP()
				if err != nil {
					return
				}
				for _, packet := range packets {
					if _, report := packet.(*rtcp.SenderReport); report {
						v.mu.Lock()
						s.reports++
						v.mu.Unlock()
					}
				}
			}
		}()
		for {
			packet, _, err := remote.ReadRTP()
			if err != nil {
				return
			}
			v.mu.Lock()
			s.count++
			if len(s.packets) < markLimit {
				s.packets = append(s.packets, mark{packet.SequenceNumber, packet.Timestamp, time.Now()})
			}
			if len(packet.Payload) > 1 {
				s.tags[packet.Payload[1]]++
			}
			v.mu.Unlock()
		}
	})
	return v
}

// pull pulls one track of a publisher and answers the SFU's offer. It returns the mid the response names.
func (v *viewer) pull(publisherConn, trackName string) string {
	v.t.Helper()
	var pulled protocol.TracksResponse
	v.svc.mustCall(v.t, "/v1/sessions/"+v.conn+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: v.scope,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: publisherConn, TrackName: trackName}},
	}, &pulled)
	if pulled.SessionDescription == nil || len(pulled.Tracks) != 1 || len(pulled.TrackErrors) != 0 {
		v.t.Fatalf("pull %s: %+v", trackName, pulled)
	}
	if err := v.peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		v.t.Fatal(err)
	}
	answer, err := v.peer.pc.CreateAnswer(nil)
	if err != nil {
		v.t.Fatal(err)
	}
	v.svc.mustCall(v.t, "/v1/sessions/"+v.conn+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: v.scope, SessionDescription: v.peer.complete(v.t, answer)}, nil)
	return pulled.Tracks[0].Mid
}

func (v *viewer) closeTrack(mid string) {
	v.t.Helper()
	var closed protocol.CloseTracksResponse
	v.svc.mustCall(v.t, "/v1/sessions/"+v.conn+"/tracks/close", protocol.CloseTracksRequest{OperationID: op(), Scope: v.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: mid}}}, &closed)
	if len(closed.Tracks) != 1 || closed.Tracks[0].AlreadyClosed {
		v.t.Fatalf("close mid %s: %+v", mid, closed)
	}
}

// ssrcs lists the streams seen so far.
func (v *viewer) seen() map[webrtc.SSRC]stream {
	v.mu.Lock()
	defer v.mu.Unlock()
	copy := make(map[webrtc.SSRC]stream, len(v.streams))
	for ssrc, s := range v.streams {
		copy[ssrc] = *s
		tags := map[byte]int{}
		for tag, n := range s.tags {
			tags[tag] = n
		}
		entry := copy[ssrc]
		entry.tags = tags
		entry.packets = s.packets[:len(s.packets):len(s.packets)]
		copy[ssrc] = entry
	}
	return copy
}

// TestClosedAudioSectionsCarryTheNextTrackWithoutStaleMedia pulls and closes audio from two
// publishers 100 times on one subscriber connection. Audio reuses its section, MID and SSRC;
// every pull delivers only the packets of the selected publisher, and the closed stream stays silent.
func TestClosedAudioSectionsCarryTheNextTrackWithoutStaleMedia(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	svc.grantSources(t, scopeA, scopeB, scopeD)
	connA := svc.createSession(t, "create-reuse-alice", scopeA)
	connD := svc.createSession(t, "create-reuse-dave", scopeD)
	connB := svc.createSession(t, "create-reuse-bob", scopeB)
	// Alice sends 'x' in audio and 'p' in video; Dave sends 'y' and 'r' (a video tag needs bit 0 clear, or the node reads the frame as a delta).
	alice := publishTaggedMedia(t, svc, connA, scopeA, 'x', 'p')
	defer alice.stop()
	dave := publishTaggedMedia(t, svc, connD, scopeD, 'y', 'r')
	defer dave.stop()
	bob := newViewer(t, svc, connB, scopeB)

	wantAudio := struct {
		track string
		kind  webrtc.RTPCodecType
		mime  string
	}{audioName, webrtc.RTPCodecTypeAudio, webrtc.MimeTypeOpus}
	publishers := []struct {
		conn string
		tags [2]byte
	}{{connA, [2]byte{'x', 'p'}}, {connD, [2]byte{'y', 'r'}}}

	const cycles = 100
	mids := map[string]bool{}
	for cycle := range cycles {
		publisher := publishers[(cycle/2)%2]
		before := bob.seen()
		mid := bob.pull(publisher.conn, wantAudio.track)
		mids[mid] = true

		var got stream
		eventually(t, "five packets of the pulled track on its mid", 10*time.Second, func() bool {
			for ssrc, s := range bob.seen() {
				if s.mid == mid && s.count-before[ssrc].count >= 5 {
					got = s
					for tag, n := range before[ssrc].tags {
						got.tags[tag] -= n
						if got.tags[tag] == 0 {
							delete(got.tags, tag)
						}
					}
					return true
				}
			}
			return false
		})
		if got.kind != wantAudio.kind || got.mime != wantAudio.mime {
			t.Fatalf("cycle %d: mid %s carries %v %s, want %v %s", cycle, mid, got.kind, got.mime, wantAudio.kind, wantAudio.mime)
		}
		wantTag := publisher.tags[0]
		if len(got.tags) != 1 || got.tags[wantTag] == 0 {
			t.Fatalf("cycle %d: mid %s received payload tags %v since the pull, want only %q", cycle, mid, got.tags, wantTag)
		}
		if len(bob.peer.pc.GetTransceivers()) > 1 {
			t.Fatalf("cycle %d: the client holds %d audio sections, want 1", cycle, len(bob.peer.pc.GetTransceivers()))
		}

		bob.closeTrack(mid)
		time.Sleep(60 * time.Millisecond) // packets already on the wire land
		for ssrc, s := range bob.seen() {
			if s.mid == mid {
				// A closed stream stays silent until the next pull of its mid.
				time.Sleep(100 * time.Millisecond)
				if after := bob.seen()[ssrc].count; after != s.count {
					t.Fatalf("cycle %d: stream %d on mid %s received %d packets after its track closed", cycle, ssrc, mid, after-s.count)
				}
			}
		}
	}
	if len(mids) != 1 {
		var used []string
		for mid := range mids {
			used = append(used, mid)
		}
		sort.Strings(used)
		t.Fatalf("%d audio pulls used mids %v, want 1", cycles, used)
	}
	// One SSRC for the life of the reused audio section: the transport keeps replay state for every
	// SSRC it has seen, so a new SSRC per pull would grow it with the pulls.
	if streams := bob.seen(); len(streams) != 1 {
		t.Fatalf("%d audio pulls produced %d distinct streams, want 1", cycles, len(streams))
	}

}

// TestReusedAudioAndVideoSendSenderReports checks that RTCP sender reports reach the client on a
// section's first use and on its reuse; the client needs them to map RTP time to wall-clock time.
func TestReusedAudioAndVideoSendSenderReports(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	svc.grantSources(t, scopeA, scopeB)
	connA := svc.createSession(t, "create-sr-alice", scopeA)
	connB := svc.createSession(t, "create-sr-bob", scopeB)
	alice := publishTaggedMedia(t, svc, connA, scopeA, 'x', 'p')
	defer alice.stop()
	bob := newViewer(t, svc, connB, scopeB)

	for _, track := range []string{audioName, videoName} {
		for use := range 2 {
			before := map[webrtc.SSRC]int{}
			for ssrc, s := range bob.seen() {
				before[ssrc] = s.reports
			}
			mid := bob.pull(connA, track)
			eventually(t, "a sender report on the pulled mid", 8*time.Second, func() bool {
				for ssrc, s := range bob.seen() {
					if s.mid == mid && s.reports > before[ssrc] {
						return true
					}
				}
				return false
			})
			t.Logf("%s use %d on mid %s received a sender report", track, use, mid)
			bob.closeTrack(mid)
		}
	}
}

// TestAReusedAudioSectionContinuesItsStream checks what the client's replay protection and jitter
// buffer need from a section that keeps its SSRC: across a close and the next pull, sequence numbers
// go on forward by a small step, and timestamps go forward by about the time that passed.
func TestAReusedSectionContinuesItsStream(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	svc.grantSources(t, scopeA, scopeB, scopeD)
	connA := svc.createSession(t, "create-continue-alice", scopeA)
	connD := svc.createSession(t, "create-continue-dave", scopeD)
	connB := svc.createSession(t, "create-continue-bob", scopeB)
	alice := publishTaggedMedia(t, svc, connA, scopeA, 'x', 'p')
	defer alice.stop()
	dave := publishTaggedMedia(t, svc, connD, scopeD, 'y', 'r')
	defer dave.stop()
	bob := newViewer(t, svc, connB, scopeB)
	// Each use pulls from the other publisher, whose own sequence numbers and timestamps are unrelated.
	publishers := []string{connA, connD}

	const idle = 400 * time.Millisecond
	for _, track := range []struct {
		name  string
		clock float64
	}{{audioName, 48000}} {
		var mid string
		for use := range 4 {
			before := map[webrtc.SSRC]int{}
			for ssrc, s := range bob.seen() {
				before[ssrc] = s.count
			}
			mid = bob.pull(publishers[use%2], track.name)
			// A first use has no stream yet, so it waits for ten packets from zero, as a reuse waits for ten more.
			eventually(t, "ten packets of the pulled track on its mid", 10*time.Second, func() bool {
				for ssrc, s := range bob.seen() {
					if s.mid == mid && s.count-before[ssrc] >= 10 {
						return true
					}
				}
				return false
			})
			bob.closeTrack(mid)
			time.Sleep(idle)
			if use == 3 {
				break
			}
		}
		var packets []mark
		for _, s := range bob.seen() {
			if s.mid == mid {
				packets = s.packets
			}
		}
		gaps := 0
		for index := 1; index < len(packets); index++ {
			before, after := packets[index-1], packets[index]
			step := int16(after.seq - before.seq)
			ticks := int32(after.ts - before.ts)
			elapsed := after.at.Sub(before.at).Seconds() * track.clock
			if step <= 0 || step > 64 {
				t.Fatalf("%s: packet %d follows sequence %d with %d (step %d); a reused section must continue forward", track.name, index, before.seq, after.seq, step)
			}
			if ticks < 0 || float64(ticks) > elapsed+track.clock/2 {
				t.Fatalf("%s: packet %d timestamp moved %d ticks in %.0f ticks of wall time", track.name, index, ticks, elapsed)
			}
			if after.at.Sub(before.at) > idle/2 {
				gaps++
			}
		}
		if gaps != 3 {
			t.Fatalf("%s: saw %d pauses between uses, want 3", track.name, gaps)
		}
	}
}

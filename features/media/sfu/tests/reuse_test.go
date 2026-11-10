package tests

import (
	"sort"
	"sync"
	"testing"
	"time"

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
}

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
		s := &stream{mid: mid, kind: remote.Kind(), mime: remote.Codec().MimeType, payloadType: uint8(remote.PayloadType()), tags: map[byte]int{}}
		v.mu.Lock()
		v.streams[remote.SSRC()] = s
		v.mu.Unlock()
		for {
			packet, _, err := remote.ReadRTP()
			if err != nil {
				return
			}
			v.mu.Lock()
			s.count++
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
		copy[ssrc] = entry
	}
	return copy
}

// TestClosedSectionsCarryTheNextTrackWithoutStaleMedia pulls and closes tracks of two publishers 100 times,
// audio and video, on one subscriber connection. The node reuses the closed track's mid, so the
// client holds one audio and one video section, and every stream on a reused section carries only
// the packets of the track pulled, in the codec of its kind. A closed stream stays silent.
func TestClosedSectionsCarryTheNextTrackWithoutStaleMedia(t *testing.T) {
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

	type pullKind struct {
		track string
		kind  webrtc.RTPCodecType
		mime  string
	}
	kinds := []pullKind{{audioName, webrtc.RTPCodecTypeAudio, webrtc.MimeTypeOpus}, {videoName, webrtc.RTPCodecTypeVideo, webrtc.MimeTypeVP8}}
	publishers := []struct {
		conn string
		tags [2]byte
	}{{connA, [2]byte{'x', 'p'}}, {connD, [2]byte{'y', 'r'}}}

	const cycles = 100
	mids := map[string]bool{}
	frozen := map[webrtc.SSRC]int{}
	var lastSSRC webrtc.SSRC
	for cycle := range cycles {
		kindIndex, publisher := cycle%2, publishers[(cycle/2)%2]
		want := kinds[kindIndex]
		mid := bob.pull(publisher.conn, want.track)
		mids[mid] = true

		var fresh webrtc.SSRC
		eventually(t, "five packets on a new stream of the pulled mid", 10*time.Second, func() bool {
			for ssrc, s := range bob.seen() {
				if _, old := frozen[ssrc]; !old && ssrc != lastSSRC && s.mid == mid && s.count >= 5 {
					fresh = ssrc
					return true
				}
			}
			return false
		})
		got := bob.seen()[fresh]
		if got.kind != want.kind || got.mime != want.mime {
			t.Fatalf("cycle %d: mid %s carries %v %s, want %v %s", cycle, mid, got.kind, got.mime, want.kind, want.mime)
		}
		if len(got.tags) != 1 || got.tags[publisher.tags[kindIndex]] == 0 {
			t.Fatalf("cycle %d: mid %s received payload tags %v, want only %q", cycle, mid, got.tags, publisher.tags[kindIndex])
		}
		if len(bob.peer.pc.GetTransceivers()) > 2 {
			t.Fatalf("cycle %d: the client holds %d sections, want 2", cycle, len(bob.peer.pc.GetTransceivers()))
		}

		bob.closeTrack(mid)
		time.Sleep(60 * time.Millisecond) // packets already on the wire land
		lastSSRC = fresh
		frozen[fresh] = bob.seen()[fresh].count
	}
	if len(mids) != 2 {
		var used []string
		for mid := range mids {
			used = append(used, mid)
		}
		sort.Strings(used)
		t.Fatalf("%d pulls used mids %v, want 2", cycles, used)
	}
	time.Sleep(300 * time.Millisecond)
	for ssrc, s := range bob.seen() {
		if s.count != frozen[ssrc] {
			t.Fatalf("stream %d on mid %s received %d packets after its track closed", ssrc, s.mid, s.count-frozen[ssrc])
		}
	}
}

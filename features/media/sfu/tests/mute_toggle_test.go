package tests

import (
	"fmt"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// A Participant who mutes and unmutes the microphone and the camera over and over keeps the
// same publications and the same SDP: each toggle is one tracks/update, and media returns to a
// viewer that never pulled again after every unmute. This is what a browser does with
// muteInPlace advertised, repeated until a leak in the hold would show.
func TestMicrophoneAndCameraTogglesKeepTheSDPAndMediaReturns(t *testing.T) {
	const toggles = 25
	svc := startService(t, newAuthority(t, "chalk test CA"))
	svc.grantSources(t, scopeA, scopeB)

	alice := &participant{name: "alice", scope: scopeA, link: newLink(t)}
	alice.peer = newMediaPeer(t, alice.link, true)
	alice.conn = svc.createSession(t, "create-alice", scopeA)
	alice.publish(t, svc, publishing{cameras: 1, chunks: [2]int{160, 160}})

	bob := &participant{name: "bob", scope: scopeB, link: newLink(t)}
	bob.peer = newMediaPeer(t, bob.link, true)
	bob.conn = svc.createSession(t, "create-bob", scopeB)
	received := collect(bob.peer)
	bob.pull(t, svc, []protocol.Track{remote(alice, micName), remote(alice, cameraName)})

	media := func(kind webrtc.RTPCodecType) int { return received.count(kind) }
	eventually(t, "audio and video before the first toggle", 20*time.Second, func() bool {
		return media(webrtc.RTPCodecTypeAudio) >= 30 && media(webrtc.RTPCodecTypeVideo) >= 30
	})

	mids := map[string]string{}
	for _, track := range svc.inspect(t, alice.conn, scopeA) {
		mids[track.TrackName] = track.Mid
	}
	sources := map[string]string{micName: "microphone", cameraName: "camera"}
	update := func(paused bool) {
		t.Helper()
		var tracks []protocol.Track
		for name, source := range sources {
			tracks = append(tracks, protocol.Track{Location: protocol.LocationLocal, Mid: mids[name], TrackName: name, Source: source, Paused: paused})
		}
		var response protocol.TracksResponse
		svc.mustCall(t, "/v1/sessions/"+alice.conn+"/tracks/update", protocol.UpdateTracksRequest{OperationID: op(), Scope: scopeA, Tracks: tracks}, &response)
		if response.SessionDescription != nil || len(response.TrackErrors) != 0 || len(response.Tracks) != len(tracks) {
			t.Fatalf("toggle response: %+v", response)
		}
	}
	offer := alice.peer.pc.CurrentLocalDescription().SDP
	answers := bob.peer.pc.CurrentLocalDescription().SDP

	var slowest time.Duration
	for toggle := 1; toggle <= toggles; toggle++ {
		update(true)
		// Packets already queued when the hold lands may still arrive; after that, nothing forwards.
		time.Sleep(300 * time.Millisecond)
		audio, video := media(webrtc.RTPCodecTypeAudio), media(webrtc.RTPCodecTypeVideo)
		time.Sleep(300 * time.Millisecond)
		if media(webrtc.RTPCodecTypeAudio) != audio || media(webrtc.RTPCodecTypeVideo) != video {
			t.Fatalf("toggle %d: media kept flowing while both publications were held", toggle)
		}

		update(false)
		started := time.Now()
		eventually(t, fmt.Sprintf("audio and video after unmute %d", toggle), 5*time.Second, func() bool {
			return media(webrtc.RTPCodecTypeAudio) >= audio+10 && media(webrtc.RTPCodecTypeVideo) >= video+10
		})
		slowest = max(slowest, time.Since(started))
	}

	for _, track := range svc.inspect(t, alice.conn, scopeA) {
		if mids[track.TrackName] != track.Mid || !track.Active {
			t.Fatalf("track %s is %+v after %d toggles, want the same mid %s and active", track.TrackName, track, toggles, mids[track.TrackName])
		}
	}
	if alice.peer.pc.CurrentLocalDescription().SDP != offer || bob.peer.pc.CurrentLocalDescription().SDP != answers {
		t.Fatalf("a toggle moved the SDP of the publisher or the viewer")
	}
	if slowest > 3*time.Second {
		t.Fatalf("slowest unmute took %s to bring audio and video back, want under 3s", slowest)
	}
	t.Logf("%d toggles of microphone and camera, no SDP, slowest return %s", toggles, slowest)
}

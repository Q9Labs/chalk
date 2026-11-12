package tests

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// A muted publisher keeps its track: the owner parks the publication with a local update, no SDP
// follows, nothing is forwarded while it is parked, and a revoke leaves it open. The viewer keeps its
// subscription through the hold, so a viewer that never saw the mute gets the media back on resume.
// parkedMic is a publisher with one published microphone and a viewer, both on the loopback node.
type parkedMic struct {
	svc      *service
	connA    string
	alice    *peer
	audio    *webrtc.TrackLocalStaticRTP
	audioMid string
	received *receiver
	pull     func()
	update   func(mid string, paused bool) protocol.TracksResponse
}

// publishMic opens the publisher's session, publishes its microphone and keeps sending until the test ends.
func publishMic(t *testing.T, svc *service, operation string) (conn string, alice *peer, audio *webrtc.TrackLocalStaticRTP, audioMid string) {
	t.Helper()
	conn = svc.createSession(t, operation, scopeA)
	alice = newPeer(t)
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := alice.pc.AddTrack(audio); err != nil {
		t.Fatal(err)
	}
	offer, err := alice.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := alice.complete(t, offer)
	audioMid = alice.mid(t, audio)
	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: scopeA, SessionDescription: &pushOffer,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: audioMid, TrackName: audioName, Source: "microphone"}},
	}, &pushed)
	if pushed.SessionDescription == nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push response: %+v", pushed)
	}
	if err := alice.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	sendCtx, stopSending := context.WithCancel(context.Background())
	var senders sync.WaitGroup
	var sent atomic.Int64
	sendLoop(sendCtx, audio, 'a', 111, &sent, &senders)
	t.Cleanup(func() { stopSending(); senders.Wait() })
	return conn, alice, audio, audioMid
}

func newParkedMic(t *testing.T) *parkedMic {
	t.Helper()
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	svc.grantSources(t, scopeA, scopeB)
	connB := svc.createSession(t, "create-bob", scopeB)
	connA, alice, audio, audioMid := publishMic(t, svc, "create-alice")
	bob := newPeer(t)
	m := &parkedMic{svc: svc, connA: connA, alice: alice, audio: audio, audioMid: audioMid, received: collect(bob)}
	m.pull = func() {
		t.Helper()
		var pulled protocol.TracksResponse
		svc.mustCall(t, "/v1/sessions/"+connB+"/tracks", protocol.TracksRequest{
			OperationID: op(), Scope: scopeB,
			Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: m.connA, TrackName: audioName}},
		}, &pulled)
		if pulled.SessionDescription == nil || len(pulled.TrackErrors) != 0 {
			t.Fatalf("pull response: %+v", pulled)
		}
		if err := bob.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
			t.Fatal(err)
		}
		answer, err := bob.pc.CreateAnswer(nil)
		if err != nil {
			t.Fatal(err)
		}
		svc.mustCall(t, "/v1/sessions/"+connB+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: scopeB, SessionDescription: bob.complete(t, answer)}, nil)
	}
	m.update = func(mid string, paused bool) protocol.TracksResponse {
		t.Helper()
		var response protocol.TracksResponse
		svc.mustCall(t, "/v1/sessions/"+m.connA+"/tracks/update", protocol.UpdateTracksRequest{
			OperationID: op(), Scope: scopeA,
			Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: mid, TrackName: audioName, Paused: paused}},
		}, &response)
		return response
	}
	return m
}

func (m *parkedMic) assertFrozen(t *testing.T, what string) {
	t.Helper()
	time.Sleep(time.Second)
	before := m.received.count(webrtc.RTPCodecTypeAudio)
	time.Sleep(1500 * time.Millisecond)
	if after := m.received.count(webrtc.RTPCodecTypeAudio); after != before {
		t.Fatalf("%s: %d packets arrived while nothing should forward", what, after-before)
	}
}

func (m *parkedMic) removePublisher(t *testing.T) {
	t.Helper()
	m.svc.mustCall(t, "/v1/sessions/"+m.connA+"/remove", protocol.RemoveSessionRequest{Scope: scopeA}, nil)
}

// A muted publisher keeps its track: the owner parks the publication with a local update, no SDP
// follows, nothing is forwarded while it is parked, and a revoke leaves it open. The viewer keeps its
// subscription through the hold, so a viewer that never saw the mute gets the media back on resume.
func TestParkedPublicationKeepsItsTrackAndForwardsNothing(t *testing.T) {
	m := newParkedMic(t)
	svc, connA, audioMid, received, pull, update := m.svc, m.connA, m.audioMid, m.received, m.pull, m.update
	assertFrozen := func(what string) { t.Helper(); m.assertFrozen(t, what) }
	pull()
	eventually(t, "media before the hold", 20*time.Second, func() bool { return received.count(webrtc.RTPCodecTypeAudio) >= 30 })

	// Parking answers with the track and no SDP, and the publication stays inspectable.
	held := update(audioMid, true)
	if held.SessionDescription != nil || len(held.TrackErrors) != 0 || len(held.Tracks) != 1 || !held.Tracks[0].Paused || held.Tracks[0].Source != "microphone" {
		t.Fatalf("hold response: %+v", held)
	}
	assertFrozen("a parked publication")
	if tracks := svc.inspect(t, connA, scopeA); len(tracks) != 1 {
		t.Fatalf("%d tracks inspected while parked, want the one kept", len(tracks))
	}
	if sessions := svc.sessions(t); sessions != 2 {
		t.Fatalf("%d sessions while parked, want both", sessions)
	}

	// A revoke while parked fences the source but does not close the publication that will resume.
	var revoked protocol.SourceControlResponse
	svc.mustCall(t, "/v1/episodes/sources", protocol.SourceControlRequest{
		TenantID: scopeA.TenantID, EpisodeID: scopeA.EpisodeID,
		Controls: []protocol.SourceControl{{ParticipantID: scopeA.ParticipantID, Source: "microphone", Action: protocol.SourceRevoke, Revision: 2}},
	}, &revoked)
	if len(revoked.Results) != 1 || !revoked.Results[0].Applied || len(revoked.Results[0].Closed) != 0 {
		t.Fatalf("revoke response while parked: %+v", revoked)
	}
	if tracks := svc.inspect(t, connA, scopeA); len(tracks) != 1 {
		t.Fatalf("%d tracks inspected after a revoke while parked, want the one kept", len(tracks))
	}

	// Resuming under a revoked lease still forwards nothing: the lease, not the hold, authorizes.
	update(audioMid, false)
	assertFrozen("a resumed publication under a revoked lease")

	// A grant reopens the lease. The viewer never pulled again, so this is the subscription it held
	// before the mute, and media returns on it.
	svc.mustCall(t, "/v1/episodes/sources", protocol.SourceControlRequest{
		TenantID: scopeA.TenantID, EpisodeID: scopeA.EpisodeID,
		Controls: []protocol.SourceControl{{ParticipantID: scopeA.ParticipantID, Source: "microphone", Action: protocol.SourceGrant, Revision: 3}},
	}, &revoked)
	resumedFrom := received.count(webrtc.RTPCodecTypeAudio)
	eventually(t, "media to the viewer that kept its subscription through the hold", 20*time.Second, func() bool { return received.count(webrtc.RTPCodecTypeAudio) >= resumedFrom+30 })

	// A mid that is not published is a per-track error and changes nothing.
	missing := update("not-a-mid", true)
	if len(missing.TrackErrors) != 1 || missing.TrackErrors[0].Code != protocol.TrackCodeNotFound {
		t.Fatalf("hold of a missing mid: %+v", missing)
	}
}

// A publisher that leaves while its microphone is parked takes the parked publication with it:
// the node keeps no track for it, nothing reaches the viewer, and the same participant can join
// again and publish a new microphone that the viewer receives.
func TestParkedPublisherLeavingFreesItsPublicationAndItCanRejoin(t *testing.T) {
	m := newParkedMic(t)
	m.pull()
	eventually(t, "media before the hold", 20*time.Second, func() bool { return m.received.count(webrtc.RTPCodecTypeAudio) >= 30 })
	if held := m.update(m.audioMid, true); len(held.TrackErrors) != 0 {
		t.Fatalf("hold response: %+v", held)
	}

	m.removePublisher(t)
	if sessions := m.svc.sessions(t); sessions != 1 {
		t.Fatalf("%d sessions after the parked publisher left, want only the viewer", sessions)
	}
	if status, _ := m.svc.call(t, "/v1/sessions/"+m.connA+"/tracks/update", protocol.UpdateTracksRequest{
		OperationID: op(), Scope: scopeA,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: m.audioMid, TrackName: audioName, Paused: false}},
	}, nil); status < 400 {
		t.Fatalf("resuming a publication of a session that left answered %d, want an error", status)
	}
	m.assertFrozen(t, "a publisher that left while parked")

	m.connA, _, _, m.audioMid = publishMic(t, m.svc, "create-alice-again")
	m.pull()
	resumedFrom := m.received.count(webrtc.RTPCodecTypeAudio)
	eventually(t, "media from the rejoined publisher", 20*time.Second, func() bool { return m.received.count(webrtc.RTPCodecTypeAudio) >= resumedFrom+30 })
}

// An unmute that races the publisher's leave must end with the session gone and nothing forwarded,
// whichever of the two the node handles first.
func TestUnmuteRacingTheLeaveForwardsNothing(t *testing.T) {
	m := newParkedMic(t)
	m.pull()
	eventually(t, "media before the hold", 20*time.Second, func() bool { return m.received.count(webrtc.RTPCodecTypeAudio) >= 30 })
	m.update(m.audioMid, true)

	var raced sync.WaitGroup
	raced.Add(2)
	go func() {
		defer raced.Done()
		m.svc.call(t, "/v1/sessions/"+m.connA+"/tracks/update", protocol.UpdateTracksRequest{
			OperationID: op(), Scope: scopeA,
			Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: m.audioMid, TrackName: audioName, Paused: false}},
		}, nil)
	}()
	go func() {
		defer raced.Done()
		m.svc.call(t, "/v1/sessions/"+m.connA+"/remove", protocol.RemoveSessionRequest{Scope: scopeA}, nil)
	}()
	raced.Wait()

	if sessions := m.svc.sessions(t); sessions != 1 {
		t.Fatalf("%d sessions after the racing leave, want only the viewer", sessions)
	}
	m.assertFrozen(t, "an unmute that raced the leave")
}

// A viewer who joins while the microphone is parked pulls it like any other publication, hears nothing
// while it is parked, and hears it on the resume with no further signalling. The API lists a parked
// microphone so that every viewer, late or not, holds its subscription before the unmute.
func TestViewerThatPullsAParkedMicrophoneHearsItOnResume(t *testing.T) {
	m := newParkedMic(t)
	eventually(t, "the publisher's media to reach the node", 20*time.Second, func() bool { return len(m.svc.inspect(t, m.connA, scopeA)) == 1 })
	if held := m.update(m.audioMid, true); len(held.TrackErrors) != 0 || !held.Tracks[0].Paused {
		t.Fatalf("hold response: %+v", held)
	}
	m.pull()
	m.assertFrozen(t, "a parked microphone pulled by a late viewer")

	m.update(m.audioMid, false)
	resumedFrom := m.received.count(webrtc.RTPCodecTypeAudio)
	eventually(t, "media to the viewer that pulled the parked microphone", 20*time.Second, func() bool { return m.received.count(webrtc.RTPCodecTypeAudio) >= resumedFrom+30 })
}

// The SDK resumes a parked microphone before Sync answers its unmute, so the lease has to be what decides
// that audio. A mute leaves the lease standing, so the resume forwards at once with no grant after it. A
// revoke, which every cause of a Sync refusal ends in, stops the resumed microphone at once.
// TestParkedPublicationKeepsItsTrackAndForwardsNothing covers the other order, where the lease is closed
// at the resume and the grant comes after it: nothing forwards until the grant.
func TestResumeUnderAStandingLeaseForwardsAtOnceAndARevokeStopsIt(t *testing.T) {
	m := newParkedMic(t)
	m.pull()
	eventually(t, "media before the hold", 20*time.Second, func() bool { return m.received.count(webrtc.RTPCodecTypeAudio) >= 30 })
	if held := m.update(m.audioMid, true); len(held.TrackErrors) != 0 || !held.Tracks[0].Paused {
		t.Fatalf("hold response: %+v", held)
	}
	m.assertFrozen(t, "a parked publication under a standing lease")

	m.update(m.audioMid, false)
	resumedFrom := m.received.count(webrtc.RTPCodecTypeAudio)
	eventually(t, "media within 2 s of a resume under a standing lease", 2*time.Second, func() bool { return m.received.count(webrtc.RTPCodecTypeAudio) >= resumedFrom+10 })

	// A revoke of a live publication closes it on the node, unlike a revoke of a parked one.
	var revoked protocol.SourceControlResponse
	m.svc.mustCall(t, "/v1/episodes/sources", protocol.SourceControlRequest{
		TenantID: scopeA.TenantID, EpisodeID: scopeA.EpisodeID,
		Controls: []protocol.SourceControl{{ParticipantID: scopeA.ParticipantID, Source: "microphone", Action: protocol.SourceRevoke, Revision: 2}},
	}, &revoked)
	if len(revoked.Results) != 1 || !revoked.Results[0].Applied || len(revoked.Results[0].Closed) != 1 || revoked.Results[0].Closed[0].SessionID != m.connA {
		t.Fatalf("revoke response: %+v", revoked)
	}
	m.assertFrozen(t, "a resumed publication after a revoke")
	if tracks := m.svc.inspect(t, m.connA, scopeA); len(tracks) != 0 {
		t.Fatalf("%d tracks inspected after the revoke, want none", len(tracks))
	}
}

package tests

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// These scenarios replay the media-control model's counterexamples against the real
// service: real HTTP, real Pion peers and real RTP.

const testLease = time.Second

func TestSourceFencing(t *testing.T) {
	svc := startService(t, newAuthority(t, "chalk test CA"), func(cfg *config.Config) {
		cfg.SourceLeaseTTL = testLease
	})
	for _, scenario := range []struct {
		name string
		run  func(*testing.T, *service)
	}{
		{"media waits for a grant and stops by the lease bound when renewals and the revoke are lost", leaseBoundsMedia},
		{"inspection reports a lapsed lease while RTP still arrives", inspectionReportsLapse},
		{"a stale renewal or a delayed push after a revoke never resumes media", staleRenewalNeverResumes},
		{"an off with no track fences a later publication", offWithNoTrackFences},
		{"a newer host stop during a pending capture wins whichever arrives first", hostStopDuringPendingCapture},
		{"an old device's late close never stops the new device, and a host stop fences both", oldDeviceCloseNeverStopsNewDevice},
	} {
		t.Run(scenario.name, func(t *testing.T) { scenario.run(t, svc) })
	}
}

func leaseBoundsMedia(t *testing.T, svc *service) {
	episode := "episode-lease"
	alice := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
	bob := join(t, svc, scopeIn(episode, "bob", 1))
	bob.pull(t, svc, alice)
	bob.silent(t, "before Sync granted the microphone")

	if result := svc.control(t, episode, grant("alice", 1)).Results[0]; !result.Applied || result.LeaseMillis <= 0 {
		t.Fatalf("grant: %+v", result)
	}
	bob.hears(t, "audio after the grant", 20)
	// Renewals keep the source forwarding well past one lease.
	for deadline := time.Now().Add(3 * testLease); time.Now().Before(deadline); time.Sleep(testLease / 4) {
		svc.control(t, episode, grant("alice", 1))
	}
	bob.hears(t, "audio while the lease is renewed", 10)

	// The host stops the microphone, but neither the revoke nor any renewal reaches the node.
	stopped := time.Now()
	eventually(t, "the lease to lapse", 3*testLease, func() bool {
		from := bob.audio()
		time.Sleep(200 * time.Millisecond)
		return bob.audio() == from
	})
	if waited := time.Since(stopped); waited > testLease+time.Second {
		t.Fatalf("media ran %s past the last renewal, beyond the %s lease", waited, testLease)
	}
	bob.silent(t, "after the lease lapsed")
	if tracks := svc.inspect(t, alice.conn, alice.scope); len(tracks) != 1 {
		t.Fatalf("the lapsed publication should stay until a revoke or close: %+v", tracks)
	}
}

// inspectionOf reads, through inspection, what a publisher sends and what a viewer is delivered.
type inspectionOf struct {
	t          *testing.T
	svc        *service
	publisher  *microphone
	subscriber *listener
}

func (i inspectionOf) published() protocol.InspectedTrack {
	i.t.Helper()
	tracks := i.svc.inspect(i.t, i.publisher.conn, i.publisher.scope)
	if len(tracks) != 1 || tracks[0].Location != protocol.LocationLocal {
		i.t.Fatalf("alice's tracks: %+v", tracks)
	}
	return tracks[0]
}

func (i inspectionOf) delivered() protocol.SubscriptionState {
	i.t.Helper()
	tracks := i.svc.inspect(i.t, i.subscriber.conn, i.subscriber.scope)
	if len(tracks) != 1 || tracks[0].Subscription == nil {
		i.t.Fatalf("bob's tracks: %+v", tracks)
	}
	return *tracks[0].Subscription
}

// beforeAnyGrant returns the delivery before any grant, which must be paused for lack of one.
func (i inspectionOf) beforeAnyGrant() protocol.SubscriptionState {
	before := i.delivered()
	if before.State != protocol.SubscriptionPaused || before.Reason != protocol.PauseSourceUnauthorized || i.published().Active {
		i.t.Fatalf("before any grant: %+v, publication active %v", before, i.published().Active)
	}
	return before
}

func inspectionReportsLapse(t *testing.T, svc *service) {
	episode := "episode-inspect"
	alice := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
	bob := join(t, svc, scopeIn(episode, "bob", 1))
	bob.pull(t, svc, alice)
	view := inspectionOf{t, svc, alice, bob}
	published, delivered := view.published, view.delivered
	before := view.beforeAnyGrant()

	svc.control(t, episode, grant("alice", 1))
	bob.hears(t, "audio after the grant", 20)
	granted := delivered()
	if granted.State != protocol.SubscriptionActive || granted.Revision <= before.Revision || !published().Active {
		t.Fatalf("after the grant: %+v (was %+v), publication active %v", granted, before, published().Active)
	}
	svc.control(t, episode, grant("alice", 1))
	if renewed := delivered(); renewed.State != protocol.SubscriptionActive || renewed.Revision != granted.Revision {
		t.Fatalf("a renewal changed the delivery: %+v, was %+v", renewed, granted)
	}

	// The microphone keeps sending, but no renewal reaches the node.
	var lapsed protocol.SubscriptionState
	eventually(t, "inspection to report the lapse", 3*testLease, func() bool {
		lapsed = delivered()
		return lapsed.State == protocol.SubscriptionPaused
	})
	if lapsed.Reason != protocol.PauseSourceUnauthorized || lapsed.Revision <= granted.Revision || lapsed.EffectiveRID != "" || published().Active {
		t.Fatalf("after the lapse: %+v (was %+v), publication active %v", lapsed, granted, published().Active)
	}
	bob.silent(t, "while the lease is lapsed")

	svc.control(t, episode, grant("alice", 1))
	bob.hears(t, "audio after the renewal", 10)
	if resumed := delivered(); resumed.State != protocol.SubscriptionActive || resumed.Revision <= lapsed.Revision || !published().Active {
		t.Fatalf("after the renewal: %+v (was %+v), publication active %v", resumed, lapsed, published().Active)
	}
}

func staleRenewalNeverResumes(t *testing.T, svc *service) {
	episode := "episode-stale"
	svc.control(t, episode, grant("alice", 2))
	svc.renew(t, episode, grant("alice", 2))
	alice := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
	bob := join(t, svc, scopeIn(episode, "bob", 1))
	bob.pull(t, svc, alice)
	bob.hears(t, "audio under the grant", 20)

	result := svc.control(t, episode, revoke("alice", 3)).Results[0]
	if !result.Applied || len(result.Closed) != 1 || result.Closed[0].Mid != alice.mid || result.Closed[0].SessionID != alice.conn {
		t.Fatalf("revoke: %+v", result)
	}
	bob.silent(t, "after the revoke")
	if tracks := svc.inspect(t, alice.conn, alice.scope); len(tracks) != 0 {
		t.Fatalf("the revoke left a publication: %+v", tracks)
	}

	if result := svc.control(t, episode, grant("alice", 2)).Results[0]; result.Applied || result.Revision != 3 {
		t.Fatalf("a stale renewal applied: %+v", result)
	}
	alice.publish(t, svc, "alice-mic-again") // the SDK's delayed enable
	bob.pull(t, svc, alice)
	bob.silent(t, "a push after the revoke")

	// Once the faults stop, a newer grant converges.
	svc.control(t, episode, grant("alice", 4))
	svc.renew(t, episode, grant("alice", 4))
	bob.hears(t, "audio after a newer grant", 20)
}

func offWithNoTrackFences(t *testing.T, svc *service) {
	episode := "episode-no-track"
	if result := svc.control(t, episode, revoke("dave", 5)).Results[0]; !result.Applied || len(result.Closed) != 0 {
		t.Fatalf("revoke without a track: %+v", result)
	}
	dave := joinAndPublish(t, svc, scopeIn(episode, "dave", 1), "dave-mic")
	bob := join(t, svc, scopeIn(episode, "bob", 1))
	bob.pull(t, svc, dave)
	if result := svc.control(t, episode, grant("dave", 4)).Results[0]; result.Applied {
		t.Fatalf("a delayed grant undid the off: %+v", result)
	}
	bob.silent(t, "a publication after an off with no track")
	svc.control(t, episode, grant("dave", 6))
	svc.renew(t, episode, grant("dave", 6))
	bob.hears(t, "audio after the user turned the microphone on again", 20)
}

func hostStopDuringPendingCapture(t *testing.T, svc *service) {
	episode := "episode-pending"
	svc.control(t, episode, grant("erin", 6))
	erin := &microphone{scope: scopeIn(episode, "erin", 1), peer: newPeer(t)}
	erin.conn = svc.createSession(t, op(), erin.scope)
	var stop sync.WaitGroup
	var stopStatus int
	stop.Go(func() {
		stopStatus, _ = svc.call(t, "/v1/episodes/sources", protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: episode, Controls: []protocol.SourceControl{revoke("erin", 7)}}, nil)
	})
	erin.publish(t, svc, "erin-mic")
	stop.Wait()
	if stopStatus != http.StatusOK {
		t.Fatalf("host stop: status %d", stopStatus)
	}
	svc.control(t, episode, grant("erin", 6)) // the enable that preceded the stop, delivered late
	bob := join(t, svc, scopeIn(episode, "bob", 1))
	var pulled protocol.TracksResponse
	status, _ := svc.call(t, "/v1/sessions/"+bob.conn+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: bob.scope,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: erin.conn, TrackName: erin.name}},
	}, &pulled)
	if status != http.StatusOK {
		t.Fatalf("pull: status %d", status)
	}
	if len(pulled.TrackErrors) == 0 {
		// The push won the race, so the revoke left a muted publication or closed it after the pull.
		bob.peer.answerOffer(t, svc, bob.conn, bob.scope, pulled.SessionDescription.SDP)
	}
	bob.silent(t, "a capture the host stopped while it was pending")
}

func oldDeviceCloseNeverStopsNewDevice(t *testing.T, svc *service) {
	episode := "episode-devices"
	svc.control(t, episode, grant("alice", 1))
	svc.renew(t, episode, grant("alice", 1))
	phone := joinAndPublish(t, svc, scopeIn(episode, "alice", 1), "alice-mic")
	bob := join(t, svc, scopeIn(episode, "bob", 1))
	bob.pull(t, svc, phone)
	bob.hears(t, "audio from the first device", 20)

	laptop := joinAndPublish(t, svc, scopeIn(episode, "alice", 2), "alice-mic")
	bob.pull(t, svc, laptop)
	bob.hears(t, "audio from the second device", 20)
	// The first device repays its off debt against its own allocation, which the second device replaced.
	status, code := svc.call(t, "/v1/sessions/"+phone.conn+"/tracks/close", protocol.CloseTracksRequest{
		OperationID: op(), Scope: phone.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: phone.mid}},
	}, nil)
	if status != http.StatusNotFound || code != protocol.CodeSessionGone {
		t.Fatalf("the old device's close: status %d code %q", status, code)
	}
	bob.hears(t, "the second device after the old device's close", 20)

	result := svc.control(t, episode, revoke("alice", 2)).Results[0]
	if !result.Applied || len(result.Closed) != 1 || result.Closed[0].SessionID != laptop.conn {
		t.Fatalf("host stop: %+v", result)
	}
	bob.silent(t, "after the host stop")
}

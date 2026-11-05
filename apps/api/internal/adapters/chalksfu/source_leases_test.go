package chalksfu_test

import (
	"context"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// standingGrant models the durable authorization of one microphone: it stands until
// the host's stop commits, whatever happens to the stop's delivery afterwards.
type standingGrant struct {
	grant    providerbridge.SourceGrant
	standing atomic.Bool
}

func (s *standingGrant) ListRenewableSourceGrants(_ context.Context, after providerbridge.SourceGrant, _ int) ([]providerbridge.SourceGrant, error) {
	if !s.standing.Load() || after != (providerbridge.SourceGrant{}) {
		return nil, nil
	}
	return []providerbridge.SourceGrant{s.grant}, nil
}

// Against the real SFU binary: renewal from durable authorization keeps a granted
// microphone flowing well past its lease, and once the host's stop commits, media
// stops within one lease and one renewal interval even though the revoke never
// reaches the node. The test runs renewal at 1 s against a 3 s lease, the same
// ratio as the API's 5 s against the node's default 15 s.
func TestRenewalKeepsGrantsLiveAndADroppedRevokeStillStopsMedia(t *testing.T) {
	const lease, renewEvery = 3 * time.Second, time.Second
	box := startSFU(t, map[string]string{"SFU_SOURCE_LEASE_TTL": lease.String()})
	service := box.service(t)
	node := box.adapterAt(t, box.controlURL)
	newID := func() utilities.ID {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	tenantID, episodeID, aliceID := newID(), newID(), newID()
	scope := func(participant string) mediaplane.Scope {
		return mediaplane.Scope{TenantID: tenantID.String(), EpisodeID: episodeID.String(), ParticipantID: participant, Generation: 1}
	}
	alice, bob := scope(aliceID.String()), scope(newID().String())
	ctx := context.Background()

	aliceConn, _ := join(t, service, alice)
	bobConn, _ := join(t, service, bob)
	publish(t, service, aliceConn, alice, "alice-mic", "microphone")
	subscriber := newPeer(t)
	pulled, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: bobConn, Scope: bob,
		Tracks: []mediaplane.Track{{Location: "remote", SessionID: aliceConn, TrackName: "alice-mic"}},
	})
	if err != nil || len(pulled.Tracks) != 1 {
		t.Fatalf("pull = %+v, %v", pulled, err)
	}
	if err := service.Renegotiate(ctx, mediaplane.RenegotiateRequest{ConnectionID: bobConn, Scope: bob, SessionDescription: subscriber.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	flowing := func() bool {
		from := subscriber.received.Load()
		time.Sleep(300 * time.Millisecond)
		return subscriber.received.Load() > from
	}

	authorization := &standingGrant{grant: providerbridge.SourceGrant{TenantID: tenantID, EpisodeID: episodeID, Node: "sfu-a", ParticipantID: aliceID, Source: "microphone", Revision: 4}}
	authorization.standing.Store(true)
	leases := providerbridge.NewSourceLeases(authorization, func(string) (providerbridge.ChalkNode, error) { return node, nil })
	renewing, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(renewEvery)
		defer ticker.Stop()
		for {
			if err := leases.Renew(renewing); err != nil && renewing.Err() == nil {
				t.Errorf("renew: %v", err)
			}
			select {
			case <-renewing.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	t.Cleanup(func() { stop(); <-done })

	eventually(t, "media under the first renewal's grant", 20*time.Second, func() bool { return subscriber.received.Load() >= 20 })
	time.Sleep(2 * lease)
	if !flowing() {
		t.Fatalf("a renewed grant stopped forwarding within %s of its first lease", 2*lease)
	}

	// The host's stop commits; its revoke is dropped and never reaches the node.
	authorization.standing.Store(false)
	stopped := time.Now()
	eventually(t, "media to stop after the stop committed", 3*lease, func() bool { return !flowing() })
	if waited, bound := time.Since(stopped), lease+renewEvery+time.Second; waited > bound {
		t.Fatalf("media ran %s after the stop committed, beyond the %s bound", waited, bound)
	}
	time.Sleep(lease)
	if flowing() {
		t.Fatal("media resumed after the lease lapsed")
	}
}

// A revoke closes the publications admitted before it and reports each by the
// connection that published it, which is how the executor knows what to record.
func TestARevokeReportsTheTracksItClosed(t *testing.T) {
	box := startSFU(t, nil)
	service := box.service(t)
	alice := scopeOf("ep-revoke", "alice")
	box.grant(t, alice)
	connection, _ := join(t, service, alice)
	_, mid, _ := publish(t, service, connection, alice, "alice-mic", "microphone")

	results, err := box.adapterAt(t, box.controlURL).ControlSources(context.Background(), mediaplane.ControlSourcesInput{
		TenantID: alice.TenantID, EpisodeID: alice.EpisodeID,
		Controls: []mediaplane.SourceControl{{ParticipantID: alice.ParticipantID, Source: "microphone", Action: mediaplane.SourceRevoke, Revision: 2}},
	})
	if err != nil || len(results) != 1 || !results[0].Applied {
		t.Fatalf("revoke = %+v, %v", results, err)
	}
	if want := []mediaplane.ClosedSourceTrack{{ConnectionID: connection, MID: mid}}; !slices.Equal(results[0].Closed, want) {
		t.Fatalf("closed = %+v, want %+v", results[0].Closed, want)
	}
}

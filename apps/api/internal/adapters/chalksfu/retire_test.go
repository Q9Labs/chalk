package chalksfu_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// pausedRead holds a binding read after it took its snapshot, so a test can commit a recovery
// between a join's read and the join's decision.
type pausedRead struct {
	*recoveryStore
	once    sync.Once
	read    chan struct{}
	release chan struct{}
}

func (p *pausedRead) Binding(ctx context.Context, tenant, episode utilities.ID) (*mediaplane.Binding, error) {
	snapshot, err := p.recoveryStore.Binding(ctx, tenant, episode)
	first := false
	p.once.Do(func() { first = true })
	if !first {
		return snapshot, err
	}
	close(p.read)
	select {
	case <-p.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return snapshot, err
}

func captureInput() captureplane.CreateCaptureConnectionInput {
	return captureplane.CreateCaptureConnectionInput{Metadata: captureplane.OperationMetadata{
		Identity: captureplane.CaptureIdentity{
			TenantID: recoveringTenant.ID, SpaceID: utilities.IDFromBytes([16]byte{2, 2}),
			EpisodeID: recoveringEpisode, RecordingID: utilities.IDFromBytes([16]byte{4, 4}),
		},
		CaptureEpoch: 1, PlanRevision: 1, IdempotencyKey: "retire-capture",
	}}
}

// The binding read-back cannot close the window between its read and the commit of a move: a
// join whose read returns the old binding after the move committed passes it. The old node's
// retirement is what ends such a join, so no second live allocation outlives the move. A join
// that lands before the retire is closed by it; one that lands after is refused by the node.
func TestAJoinWhoseBindingReadRacesTheMoveLeavesNoSessionOnTheOldNode(t *testing.T) {
	for _, resume := range []bool{false, true} {
		name := map[bool]string{false: "create", true: "resume"}[resume]
		t.Run(name, func(t *testing.T) {
			ca, primary, standby, nodes := twoNodes(t, roomy)
			first := primary.fleetOf(t, ca, clientIdentity, nodes...)
			second := primary.fleetOf(t, ca, clientIdentity, nodes...)
			bound := placedBinding(t, first)
			second.Probe(context.Background())
			store := newRecoveryStore(bound, 2)
			barrier := &pausedRead{recoveryStore: store, read: make(chan struct{}), release: make(chan struct{})}
			stale, err := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
				ProcessConfig: withCloudflare, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU,
				ChalkSFU: first, ChalkSFUSpaces: everySpace, Episodes: store, Recovery: barrier,
			}).ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
			if err != nil {
				t.Fatal(err)
			}
			scope := recoveringScope("pending")
			connection := ""
			if resume {
				connection, _ = join(t, primary.service(t), scope)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			result := make(chan error, 1)
			go func() {
				episode := mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID}
				var err error
				if resume {
					_, err = stale.ResumeJoin(ctx, mediaplane.ResumeJoinInput{Provider: mediaplane.ProviderChalkSFU, Scope: scope, Episode: episode, ExternalParticipantID: scope.ParticipantID, ConnectionRef: connection})
				} else {
					_, err = stale.CreateJoin(ctx, mediaplane.CreateJoinInput{Provider: mediaplane.ProviderChalkSFU, Scope: scope, Episode: episode, ParticipantName: scope.ParticipantID, ExternalParticipantID: scope.ParticipantID, ParticipantPreset: "contributor"})
				}
				result <- err
			}()
			select {
			case <-barrier.read:
			case <-ctx.Done():
				t.Fatal("the join did not reach its binding read")
			}
			chalksfu.MarkSilent(second, "sfu-primary")
			recovered := recoveryRegistry(second, store)
			if err := resolve(recovered); err != nil {
				close(barrier.release)
				t.Fatal(err)
			}
			current, err := recovered.ResolveEpisode(ctx, recoveringTenant, chalkSpace, recoveringEpisode)
			if err != nil {
				close(barrier.release)
				t.Fatal(err)
			}
			join(t, *current, recoveringScope("new-node"))
			close(barrier.release)
			<-result // the join may report success: its session is gone, and its client's first negotiation says so

			if sessions := stateOf(t, primary).Sessions; sessions != 0 {
				t.Fatalf("the node the Episode left holds %d sessions after the move committed, want 0", sessions)
			}
			if sessions := stateOf(t, standby).Sessions; sessions != 1 {
				t.Fatalf("the new node holds %d sessions, want the one that joined it", sessions)
			}
			// A stale join that lands after the retire is refused by the node.
			_, err = stale.CreateJoin(ctx, mediaplane.CreateJoinInput{
				Provider: mediaplane.ProviderChalkSFU, Scope: recoveringScope("later"), Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID},
				ParticipantName: "later", ExternalParticipantID: "later", ParticipantPreset: "contributor",
			})
			if !errors.Is(err, mediaplane.ErrBindingStale) || stateOf(t, primary).Sessions != 0 {
				t.Fatalf("a stale join after the move: %v, old node sessions %d, want the stale-binding retry error and none", err, stateOf(t, primary).Sessions)
			}
		})
	}
}

// A capture plane resolved before the move still names the old node and the old generation. The
// node refuses its capture, so a recording never opens a second allocation.
func TestAStaleCapturePlaneIsRefusedByTheRetiredNode(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	join(t, primary.service(t), recoveringScope("old-participant"))
	oldPlane, err := fleet.CapturePlane(bound.Node, bound.NodeIncarnation, bound.Generation)
	if err != nil {
		t.Fatal(err)
	}
	chalksfu.MarkSilent(fleet, "sfu-primary")
	registry := recoveryRegistry(fleet, store)
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	current, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	if err != nil {
		t.Fatal(err)
	}
	join(t, *current, recoveringScope("new-node"))
	if sessions := stateOf(t, primary).Sessions; sessions != 0 {
		t.Fatalf("the retired node holds %d sessions, want 0", sessions)
	}
	if result, err := oldPlane.CreateCaptureConnection(context.Background(), captureInput()); err == nil {
		t.Fatalf("a capture was created on the retired allocation: %+v; old sessions %d, new sessions %d", result, stateOf(t, primary).Sessions, stateOf(t, standby).Sessions)
	}
	if sessions := stateOf(t, primary).Sessions; sessions != 0 {
		t.Fatalf("the retired node holds %d sessions after the refused capture, want 0", sessions)
	}
	moved, _ := store.current()
	newPlane, err := fleet.CapturePlane(moved.Node, moved.NodeIncarnation, moved.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newPlane.CreateCaptureConnection(context.Background(), captureInput()); err != nil {
		t.Fatalf("a capture on the new allocation: %v", err)
	}
}

// An adapter issued under the old binding can no longer grant a source or take a publication: the
// retire closed its session, and the node refuses its source grants and renewals.
func TestARetiredAdapterCannotGrantASourceOrPublish(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	old, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	if err != nil {
		t.Fatal(err)
	}
	scope := recoveringScope("alice")
	connection, _ := join(t, *old, scope)
	chalksfu.MarkSilent(fleet, "sfu-primary")
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	current, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	if err != nil {
		t.Fatal(err)
	}
	next := scope
	next.Generation = 2
	nextConnection, _ := join(t, *current, next)

	primaryNode, err := fleet.Node(bound.Node)
	if err != nil {
		t.Fatal(err)
	}
	retired := primaryNode.Bound(bound.NodeIncarnation, bound.Generation)
	grant := mediaplane.ControlSourcesInput{TenantID: scope.TenantID, EpisodeID: scope.EpisodeID, Controls: []mediaplane.SourceControl{
		{ParticipantID: scope.ParticipantID, Source: "microphone", Action: mediaplane.SourceGrant, Revision: 1},
	}}
	if _, err := retired.ControlSources(context.Background(), grant); err == nil {
		t.Fatal("an adapter issued under the old binding granted a source after the move")
	}
	// A valid publication: a real offer with one audio track. Against a live session this very
	// request succeeds (the control below), so only the retired session's absence can fail it.
	publisher := newPeer(t)
	track := publisher.addAudio(t, "alice-mic")
	offer := publisher.offer(t)
	_, err = mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, retired).AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: connection, Scope: scope, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, track), TrackName: "alice-mic", Source: "microphone"}},
	})
	if !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("a publication on the retired session: %v, want the connection-not-found outcome", err)
	}
	if sessions := stateOf(t, primary).Sessions; sessions != 0 {
		t.Fatalf("the retired node holds %d sessions, want 0", sessions)
	}
	if sessions := stateOf(t, standby).Sessions; sessions != 1 {
		t.Fatalf("the new node holds %d sessions, want 1", sessions)
	}
	// The same publication on the live session of the new allocation succeeds.
	publish(t, *current, nextConnection, next, "alice-mic-new", "microphone")
	// The new allocation's adapter grants as usual.
	newNode, err := fleet.Node("sfu-standby")
	if err != nil {
		t.Fatal(err)
	}
	moved, _ := store.current()
	if _, err := newNode.Bound(moved.NodeIncarnation, moved.Generation).ControlSources(context.Background(), grant); err != nil {
		t.Fatalf("the new allocation's source grant: %v", err)
	}
}

// An Episode that returns to a node which kept its old sessions retires them too, and only them:
// the sessions it has joined under its new generation survive.
func TestAnEpisodeThatReturnsToANodeRetiresItsOldSessionsAndKeepsTheNewOnes(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	join(t, primary.service(t), recoveringScope("old"))

	away, err := bound.Moved(mediaplane.Placement{Node: "sfu-standby", Incarnation: stateOf(t, standby).NodeIncarnation, Reason: mediaplane.PlacementStandby})
	if err != nil {
		t.Fatal(err)
	}
	back, err := away.Moved(mediaplane.Placement{Node: "sfu-primary", Incarnation: stateOf(t, primary).NodeIncarnation, Reason: mediaplane.PlacementPrimary})
	if err != nil {
		t.Fatal(err)
	}
	store.set(back)
	primaryNode, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, primaryNode.Bound(back.NodeIncarnation, back.Generation)), recoveringScope("new"))
	if sessions := stateOf(t, primary).Sessions; sessions != 2 {
		t.Fatalf("the node holds %d sessions before the resolve, want the old one and the new one", sessions)
	}
	recoveryRegistry(fleet, store).PayRetirements(context.Background())
	if sessions := stateOf(t, primary).Sessions; sessions != 1 {
		t.Fatalf("the node holds %d sessions after the resolve, want only the one joined under generation %d", sessions, back.Generation)
	}
}

package chalksfu_test

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
)

// A caller that names no generation counts as generation 0, so once the node retired the Episode it
// cannot open a session by leaving the generation out.
func TestACallerThatNamesNoGenerationIsRefusedOnceTheNodeRetiredTheEpisode(t *testing.T) {
	ca, primary, standby, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	join(t, primary.service(t), recoveringScope("alice"))
	chalksfu.MarkSilent(fleet, "sfu-primary")
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	if sessions := stateOf(t, primary).Sessions; sessions != 0 {
		t.Fatalf("the old node holds %d sessions after the retire, want 0", sessions)
	}
	_, err := primary.service(t).CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: recoveringScope("legacy"),
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: recoveringEpisode.String()},
		ParticipantName: "legacy", ExternalParticipantID: "legacy", ParticipantPreset: "contributor",
	})
	if err == nil {
		t.Fatal("a join that names no generation opened a session on the retired allocation")
	}
	if sessions := stateOf(t, primary).Sessions; sessions != 0 {
		t.Fatalf("the old node holds %d sessions after the refused join, want 0", sessions)
	}
	if sessions := stateOf(t, standby).Sessions; sessions != 0 {
		t.Fatalf("the new node holds %d sessions it was never given", sessions)
	}
}

// The production constructor (the one cmd/main.go gives the source workers) issues every node
// under the binding's generation. A source grant or lease renewal from the allocation the Episode
// left is refused, and the one from the current allocation is applied.
func TestTheProductionFactoryRefusesASourceControlFromAnAllocationTheEpisodeLeft(t *testing.T) {
	ca, primary, _, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	factory := providerbridge.ChalkNodesOf(func(node string, generation int64) (*chalksfu.Adapter, error) {
		return fleet.Allocation(node, "", generation)
	})
	join(t, primary.service(t), recoveringScope("alice"))
	chalksfu.MarkSilent(fleet, "sfu-primary")
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	moved, _ := store.current()

	grant := mediaplane.ControlSourcesInput{TenantID: recoveringTenant.ID.String(), EpisodeID: recoveringEpisode.String(), Controls: []mediaplane.SourceControl{
		{ParticipantID: "alice", Source: "microphone", Action: mediaplane.SourceGrant, Revision: 1},
	}}
	left, err := factory(bound.Node, bound.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := left.ControlSources(context.Background(), grant); err == nil {
		t.Fatal("the factory's adapter for the allocation the Episode left applied a source grant")
	}
	current, err := factory(moved.Node, moved.Generation)
	if err != nil {
		t.Fatal(err)
	}
	results, err := current.ControlSources(context.Background(), grant)
	if err != nil || len(results) != 1 {
		t.Fatalf("the current allocation's source grant: %+v, %v", results, err)
	}
	// An adapter that omits the generation (a caller that bypasses the factory) is refused too.
	raw, err := fleet.Node(bound.Node)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ControlSources(context.Background(), grant); err == nil {
		t.Fatal("an adapter that names no generation applied a source grant on the retired node")
	}
}

// Source authority is fenced by allocation. A microphone granted on the first node, revoked on the
// second, and then followed by a return to the first node's same boot must not let the new
// publication inherit the first node's old grant: it needs a fresh grant. Real SFU processes.
func TestAGrantFromAnOlderAllocationNeverAuthorizesALaterPublication(t *testing.T) {
	ca, primary, _, nodes := twoNodes(t, roomy)
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	factory := providerbridge.ChalkNodesOf(func(node string, generation int64) (*chalksfu.Adapter, error) {
		return fleet.Allocation(node, "", generation)
	})
	control := func(binding mediaplane.Binding, action mediaplane.SourceAction, revision int64) {
		t.Helper()
		node, err := factory(binding.Node, binding.Generation)
		if err != nil {
			t.Fatal(err)
		}
		_, err = node.ControlSources(context.Background(), mediaplane.ControlSourcesInput{TenantID: recoveringTenant.ID.String(), EpisodeID: recoveringEpisode.String(), Controls: []mediaplane.SourceControl{
			{ParticipantID: "alice", Source: "microphone", Action: action, Revision: revision},
		}})
		if err != nil {
			t.Fatalf("%s revision %d on %s generation %d: %v", action, revision, binding.Node, binding.Generation, err)
		}
	}

	control(bound, mediaplane.SourceGrant, 1) // granted on the first node
	chalksfu.MarkSilent(fleet, "sfu-primary")
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	onSecond, _ := store.current()
	if onSecond.Node != "sfu-standby" {
		t.Fatalf("the first move went to %q, want the standby", onSecond.Node)
	}
	control(onSecond, mediaplane.SourceRevoke, 2) // revoked on the second

	fleet.Probe(context.Background())
	chalksfu.MarkSilent(fleet, "sfu-standby")
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	back, _ := store.current()
	if back.Node != "sfu-primary" || back.NodeIncarnation != bound.NodeIncarnation || back.Generation != 2 {
		t.Fatalf("the second move: %+v, want the first node's same boot at generation 2", back)
	}

	service, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	if err != nil {
		t.Fatal(err)
	}
	alice, bob := recoveringScope("alice"), recoveringScope("bob")
	aliceConn, _ := join(t, *service, alice)
	bobConn, _ := join(t, *service, bob)
	publish(t, *service, aliceConn, alice, "alice-mic", "microphone")
	subscriber := newPeer(t)
	pulled, err := service.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: bobConn, Scope: bob,
		Tracks: []mediaplane.Track{{Location: "remote", SessionID: aliceConn, TrackName: "alice-mic"}},
	})
	if err != nil || len(pulled.Tracks) != 1 {
		t.Fatalf("pull = %+v, %v", pulled, err)
	}
	if err := service.Renegotiate(context.Background(), mediaplane.RenegotiateRequest{ConnectionID: bobConn, Scope: bob, SessionDescription: subscriber.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	reason := func() string {
		t.Helper()
		states, err := service.SubscriptionStates(context.Background(), mediaplane.SubscriptionStatesRequest{ConnectionID: bobConn, Scope: bob})
		if err != nil || len(states) != 1 {
			t.Fatalf("states = %+v, %v", states, err)
		}
		return states[0].State + "/" + states[0].Reason
	}
	unauthorized := mediaplane.SubscriptionPaused + "/" + mediaplane.PauseSourceUnauthorized
	if got := reason(); got != unauthorized {
		t.Fatalf("the new publication reads %q, want %q: it inherited the old node's grant", got, unauthorized)
	}
	control(back, mediaplane.SourceGrant, 3)
	if got := reason(); got == unauthorized {
		t.Fatalf("a fresh grant on the current allocation left the publication %q", got)
	}
}

// A restart recovery installs the Episode's floor on the new boot, so an adapter issued at the
// earlier generation cannot open a capture there, and a capture answered by a boot other than the
// one the plane was issued for is refused and its session closed.
func TestARestartRecoveryRefusesAStaleGenerationAndAStaleBootForACapture(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	fleet := box.fleetWithOverflow(t, ca, clientIdentity, true, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	before, err := fleet.CapturePlane("sfu-a", bound.NodeIncarnation, bound.Generation)
	if err != nil {
		t.Fatal(err)
	}

	restart(t, box)
	fleet.Probe(context.Background())
	if err := resolve(registry); err != nil {
		t.Fatalf("restart recovery: %v", err)
	}
	moved, _ := store.current()
	if moved.Generation != 1 || moved.Node != "sfu-a" || moved.NodeIncarnation == bound.NodeIncarnation {
		t.Fatalf("restart recovery: %+v", moved)
	}
	// A Participant's join makes the new boot host the Episode, so only the generation and boot
	// checks can refuse the captures below.
	service, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	if err != nil {
		t.Fatal(err)
	}
	join(t, *service, recoveringScope("alice"))
	if _, err := before.CreateCaptureConnection(context.Background(), captureInput()); err == nil {
		t.Fatal("a capture from the generation before the restart recovery was created")
	}
	staleBoot, err := fleet.CapturePlane("sfu-a", bound.NodeIncarnation, moved.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := staleBoot.CreateCaptureConnection(context.Background(), captureInput()); err == nil {
		t.Fatal("a capture issued for the earlier boot was accepted")
	}
	if sessions := stateOf(t, box).Sessions; sessions != 1 {
		t.Fatalf("the refused captures left %d sessions on the node, want only the Participant's", sessions)
	}
	current, err := fleet.CapturePlane("sfu-a", moved.NodeIncarnation, moved.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := current.CreateCaptureConnection(context.Background(), captureInput()); err != nil {
		t.Fatalf("a capture on the current allocation: %v", err)
	}
}

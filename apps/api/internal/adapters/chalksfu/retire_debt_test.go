package chalksfu_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// partition is a TCP relay in front of a node's control port. Severing it drops every open
// connection and refuses new ones until it heals, as a network partition between the API and one
// node does, while the node itself keeps running and keeps its sessions.
type partition struct {
	listener net.Listener
	target   string
	mu       sync.Mutex
	severed  bool
	open     []net.Conn
}

func newPartition(t *testing.T, controlURL string) *partition {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &partition{listener: listener, target: strings.TrimPrefix(controlURL, "https://")}
	t.Cleanup(func() { _ = listener.Close(); p.drop() })
	go p.serve()
	return p
}

func (p *partition) url() string { return "https://" + p.listener.Addr().String() }

func (p *partition) serve() {
	for {
		client, err := p.listener.Accept()
		if err != nil {
			return
		}
		p.mu.Lock()
		severed := p.severed
		p.mu.Unlock()
		upstream, dialErr := net.Dial("tcp", p.target)
		if severed || dialErr != nil {
			_ = client.Close()
			continue
		}
		p.mu.Lock()
		p.open = append(p.open, client, upstream)
		p.mu.Unlock()
		go func() { _, _ = io.Copy(upstream, client); _ = upstream.Close() }()
		go func() { _, _ = io.Copy(client, upstream); _ = client.Close() }()
	}
}

func (p *partition) drop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, conn := range p.open {
		_ = conn.Close()
	}
	p.open = nil
}

func (p *partition) sever() {
	p.mu.Lock()
	p.severed = true
	p.mu.Unlock()
	p.drop()
}

func (p *partition) heal() {
	p.mu.Lock()
	p.severed = false
	p.mu.Unlock()
}

// failingDebts fails the debt write the Episode's end makes. With afterWrite the debt is stored
// first and the error comes after, as a crash between the write and its acknowledgement would.
type failingDebts struct {
	*recoveryStore
	fail       bool
	afterWrite bool
}

func (f *failingDebts) RecordRetirementDebts(ctx context.Context, debts []mediaplane.RetirementDebt) error {
	if !f.fail {
		return f.recoveryStore.RecordRetirementDebts(ctx, debts)
	}
	if f.afterWrite {
		if err := f.recoveryStore.RecordRetirementDebts(ctx, debts); err != nil {
			return err
		}
	}
	return errors.New("injected fault")
}

// The Episode's end is confirmed on durable ownership of the cleanup, not on the old node's
// acknowledgement. The debt row, written with the binding move, is that ownership: the end
// confirms while a partitioned node still holds the Episode's stale sessions, and the retirement
// worker pays the debt once the node is reachable, with no further resolve. A node that never
// returns keeps its stale sessions until it restarts or its floor lifetime ends, and the sources
// it forwards lapse within the source lease lifetime because the API no longer renews them.
func TestEpisodeEndConfirmsOnTheDurableDebtNotTheNodeAndTheWorkerPaysItAfterTheHeal(t *testing.T) {
	ca, primary, _, nodes := twoNodes(t, roomy)
	relay := newPartition(t, primary.controlURL)
	nodes[0].ControlURL = relay.url()
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	join(t, primary.service(t), recoveringScope("alice"))

	relay.sever()
	chalksfu.MarkSilent(fleet, "sfu-primary")
	if err := resolve(registry); err != nil {
		t.Fatalf("recovery behind a partition: %v", err)
	}
	if moved, _ := store.current(); moved.Generation != 1 {
		t.Fatalf("the Episode did not move: %+v", moved)
	}
	if owed := store.owed(); owed != 1 {
		t.Fatalf("%d retirement debts after a move the old node did not hear, want 1", owed)
	}

	// The Episode ends while the node is still unreachable. The end confirms (nil) because the
	// debt is durable, and the node still holds its stale session: that is the stated trade-off.
	if err := registry.EndRetiredAllocations(context.Background(), recoveringTenant.ID, recoveringEpisode); err != nil {
		t.Fatalf("the end must confirm on the durable debt while the node is unreachable: %v", err)
	}
	logs := &bytes.Buffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	registry.PayRetirements(context.Background())
	slog.SetDefault(previous)
	if owed, sessions := store.owed(), stateOf(t, primary).Sessions; owed != 1 || sessions != 1 {
		t.Fatalf("behind the partition: %d debts and %d stale sessions, want 1 and 1", owed, sessions)
	}
	// The unpaid retire names its Tenant and Episode, and the transport error behind it
	// reaches the log as a cause, never as the node's address.
	pending := logs.String()
	relayHost := strings.TrimPrefix(relay.url(), "https://")
	if !strings.Contains(pending, `"event":"chalk_sfu.retire_pending"`) ||
		!strings.Contains(pending, `"tenant_id":"`+recoveringTenant.ID.String()+`"`) ||
		!strings.Contains(pending, `"episode_id":"`+recoveringEpisode.String()+`"`) {
		t.Fatalf("retire_pending log lacks its event, Tenant or Episode: %s", pending)
	}
	if strings.Contains(pending, relayHost) || strings.Contains(pending, "https://") {
		t.Fatalf("retire_pending log leaks the node address %q: %s", relayHost, pending)
	}
	if backlog, observed := registry.RetirementBacklog(); !observed || backlog.Count != 1 {
		t.Fatalf("the unpaid debt is not visible: %+v observed %v", backlog, observed)
	}

	relay.heal()
	registry.PayRetirements(context.Background())
	if owed, sessions := store.owed(), stateOf(t, primary).Sessions; owed != 0 || sessions != 0 {
		t.Fatalf("after the partition healed: %d debts and %d sessions on the old node, want 0 and 0", owed, sessions)
	}
	if backlog, _ := registry.RetirementBacklog(); backlog.Count != 0 {
		t.Fatalf("the paid debt is still counted: %+v", backlog)
	}
}

// No state confirms an Episode's end without its debt row, and no fault loses a debt. A fault
// before the write fails the end (so the executor retries it) and writes nothing. A fault after
// the write also fails the end, leaves the row, and the retry neither duplicates it nor loses it.
func TestAFaultAroundTheDebtWriteNeverConfirmsAnEndWithoutTheDebtOrLosesIt(t *testing.T) {
	for _, afterWrite := range []bool{false, true} {
		name := map[bool]string{false: "before the write", true: "after the write"}[afterWrite]
		t.Run(name, func(t *testing.T) {
			ca, primary, standby, nodes := twoNodes(t, roomy)
			fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
			bound := placedBinding(t, fleet)
			store := newRecoveryStore(bound, 2)
			join(t, primary.service(t), recoveringScope("alice"))
			// A binding another replica moved without recording a debt (an Episode moved by the
			// previous release): only the end can write it.
			moved, err := bound.Moved(mediaplane.Placement{Node: "sfu-standby", Incarnation: stateOf(t, standby).NodeIncarnation, Reason: mediaplane.PlacementStandby})
			if err != nil {
				t.Fatal(err)
			}
			store.mu.Lock()
			store.binding = moved
			store.mu.Unlock()
			faulty := &failingDebts{recoveryStore: store, fail: true, afterWrite: afterWrite}
			registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
				ProcessConfig: withCloudflare, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU,
				ChalkSFU: fleet, ChalkSFUSpaces: everySpace, Episodes: store, Recovery: faulty,
			})

			err = registry.EndRetiredAllocations(context.Background(), recoveringTenant.ID, recoveringEpisode)
			if err == nil {
				t.Fatal("the end confirmed although the debt write failed")
			}
			if owed := store.owed(); afterWrite && owed != 1 || !afterWrite && owed != 0 {
				t.Fatalf("%d debts after a fault %s", owed, name)
			}
			if sessions := stateOf(t, primary).Sessions; sessions != 1 {
				t.Fatalf("the node was asked to retire although the end did not confirm: %d sessions", sessions)
			}

			faulty.fail = false // the executor retries the end
			if err := registry.EndRetiredAllocations(context.Background(), recoveringTenant.ID, recoveringEpisode); err != nil {
				t.Fatalf("the retried end: %v", err)
			}
			if owed, sessions := store.owed(), stateOf(t, primary).Sessions; owed != 0 || sessions != 0 {
				t.Fatalf("after the retry: %d debts and %d sessions, want the node retired and the debt paid", owed, sessions)
			}
		})
	}
}

// A node that restarted while it was unreachable has nothing left to retire: the worker sees the
// new boot and drops the debt.
func TestARetirementDebtEndsWhenTheNodeCameBackAsANewBoot(t *testing.T) {
	ca, primary, _, nodes := twoNodes(t, roomy)
	relay := newPartition(t, primary.controlURL)
	nodes[0].ControlURL = relay.url()
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	bound := placedBinding(t, fleet)
	store := newRecoveryStore(bound, 2)
	registry := recoveryRegistry(fleet, store)
	join(t, primary.service(t), recoveringScope("alice"))

	relay.sever()
	chalksfu.MarkSilent(fleet, "sfu-primary")
	if err := resolve(registry); err != nil {
		t.Fatal(err)
	}
	if owed := store.owed(); owed != 1 {
		t.Fatalf("%d debts, want 1", owed)
	}
	restart(t, primary)
	relay.heal()
	fleet.Probe(context.Background())
	registry.PayRetirements(context.Background())
	if owed := store.owed(); owed != 0 {
		t.Fatalf("%d debts after the node restarted, want 0", owed)
	}
}

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

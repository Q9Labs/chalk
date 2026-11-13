package chalksfu_test

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

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
				ProcessConfig: withCloudflare, DefaultProvider: mediaplane.ProviderCloudflareSFU,
				ChalkSFU: fleet, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace}, Episodes: store, Recovery: faulty,
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

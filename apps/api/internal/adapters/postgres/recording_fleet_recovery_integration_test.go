package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetcontrol"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

// Exercise the real SQL authority, HTTP router/client and reconciler together.
// The test itself uses the pre-recovery API, so it also runs unchanged on master.
func TestFleetRecoveryLostAndRevokedRowsWithPostgres(t *testing.T) {
	for _, kind := range []string{"capture", "render", "transcription"} {
		for _, state := range []string{"missing", "revoked"} {
			for _, phase := range []recorderfleet.Phase{recorderfleet.PhaseReady, recorderfleet.PhaseBootstrapping} {
				for _, skew := range []time.Duration{-5 * time.Minute, 0, 5 * time.Minute} {
					t.Run(fmt.Sprintf("%s/%s/%s/%s", kind, state, phase, skew), func(t *testing.T) {
						tx, fixture := newAllocationCleanupFixture(t, false, kind)
						defer func() { _ = tx.Rollback(context.Background()) }()
						role := workeridentity.RoleCapture
						if kind != "capture" {
							role = workeridentity.RoleRender
						}
						config := fleetRecoveryConfig(role)
						workerID, err := utilities.NewID()
						if err != nil {
							t.Fatal(err)
						}
						identity := recorderfleet.NodeIdentity{ProviderID: "recover-node", WorkerID: workerID.String(), Role: role, BootGeneration: 1}
						repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
						request := recorderfleet.BootstrapRequest{Key: config.Key, ProviderID: identity.ProviderID, NodeName: "recover-node", Region: "sgp1", ReleaseID: config.Release.ReleaseID, ImageDigest: config.Release.ImageDigest, BootGeneration: 1, InventoryDigest: strings.Repeat("b", 64)}
						if state == "revoked" {
							if _, err := repository.ReserveBootstrap(t.Context(), request); err != nil {
								t.Fatal(err)
							}
							if _, err := repository.ActivateBootstrap(t.Context(), request, identity); err != nil {
								t.Fatal(err)
							}
							if err := repository.MarkRevoked(t.Context(), config.Key.Environment, identity, time.Now()); err != nil {
								t.Fatal(err)
							}
							if err := repository.CloseAdmission(t.Context(), config.Key.Environment, identity); !errors.Is(err, recorderfleet.ErrNodeNotFound) {
								t.Fatalf("revoked row must reject admission close: %v", err)
							}
						}
						execCleanupFixture(t, tx, `update recording_jobs set lease_owner=$2, lease_expires_at=clock_timestamp()+interval '10 minutes' where id=$1`, fixture.jobID.Bytes(), workerID.String())
						issuer := &fleetRecoveryIssuer{}
						service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, issuer)
						if err != nil {
							t.Fatal(err)
						}
						server := httptest.NewTLSServer(httpapi.NewRecorderFleetControllerRouter(service, fleetRecoveryVerifier{}, config.Key.Environment, nil))
						defer server.Close()
						control, err := recorderfleetcontrol.New(recorderfleetcontrol.Config{BaseURL: server.URL, HTTPClient: server.Client(), Key: config.Key})
						if err != nil {
							t.Fatal(err)
						}
						provider := &fleetRecoveryProvider{nodes: map[string]recorderfleet.Node{}}
						node := fleetRecoveryNode(config, identity.ProviderID)
						provider.nodes[node.ProviderID] = node
						journal := &fleetRecoveryJournal{state: recorderfleet.NewJournal()}
						journal.state.NextBootGeneration = 2
						readyAt := time.Now().Add(-time.Second)
						journal.state.Nodes[node.ProviderID] = recorderfleet.ManagedNode{ProviderID: node.ProviderID, Name: node.Name, Phase: phase, BootGeneration: 1, Identity: &identity, LastReadyAt: &readyAt}
						clockSkew := time.Duration(0)
						config.Now = func() time.Time { return time.Now().Add(clockSkew) }
						demand := fleetRecoveryDemand{now: config.Now}
						r, err := recorderfleet.NewReconciler(config, demand, journal, provider, control, control)
						if err != nil {
							t.Fatal(err)
						}
						// A live database lease must survive even if the controller clock is
						// ahead of or behind the API/DB, and even if no fleet row exists.
						for i := range 3 {
							if i > 0 {
								clockSkew = skew
							}
							if _, err := r.Reconcile(t.Context()); err != nil {
								t.Fatal(err)
							}
						}
						if issuer.revokes != 0 || provider.deletes != 0 {
							t.Fatal("live lease revoked or deleted")
						}
						// Only the database clock ends the lease. Once clocks align, the normal
						// fresh-after-drain zero guard permits revocation and deletion.
						execCleanupFixture(t, tx, `update recording_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1`, fixture.jobID.Bytes())
						clockSkew = 0
						for range 5 {
							if _, err := r.Reconcile(t.Context()); err != nil {
								t.Fatal(err)
							}
						}
						if issuer.revokes != 1 || provider.deletes != 1 || len(journal.state.Nodes) != 0 {
							t.Fatalf("recovery stuck: revokes=%d deletes=%d journal=%+v", issuer.revokes, provider.deletes, journal.state)
						}
						observations, err := repository.ObserveNodes(t.Context(), config.Key, time.Now())
						if err != nil || len(observations) != 1 || !observations[0].IdentityRevoked || observations[0].Identity != identity {
							t.Fatalf("durable tombstone missing: %+v %v", observations, err)
						}
						if _, err := repository.ReserveBootstrap(t.Context(), request); err == nil {
							t.Fatal("revoked identity was resurrected")
						}
						if err := repository.MarkRevoked(t.Context(), config.Key.Environment, identity, time.Now()); err != nil {
							t.Fatalf("tombstone retry: %v", err)
						}
						conflict := identity
						conflict.BootGeneration++
						if err := repository.MarkRevoked(t.Context(), config.Key.Environment, conflict, time.Now()); err == nil {
							t.Fatal("conflicting generation changed tombstone")
						}
					})
				}
			}
		}
	}
}

func TestFleetRecoveryAbsentActiveRowWithPostgres(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		t.Run(string(role), func(t *testing.T) {
			tx, _ := newAllocationCleanupFixture(t, true, string(role))
			defer func() { _ = tx.Rollback(context.Background()) }()
			config := fleetRecoveryConfig(role)
			repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
			workerID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			identity := recorderfleet.NodeIdentity{ProviderID: "gone", WorkerID: workerID.String(), Role: role, BootGeneration: 1}
			request := recorderfleet.BootstrapRequest{Key: config.Key, ProviderID: identity.ProviderID, NodeName: "gone", Region: "sgp1", ReleaseID: config.Release.ReleaseID, ImageDigest: config.Release.ImageDigest, BootGeneration: 1, InventoryDigest: strings.Repeat("b", 64)}
			if _, err := repository.ReserveBootstrap(t.Context(), request); err != nil {
				t.Fatal(err)
			}
			if _, err := repository.ActivateBootstrap(t.Context(), request, identity); err != nil {
				t.Fatal(err)
			}
			execCleanupFixture(t, tx, `update recording_fleet_nodes set observed_at=clock_timestamp()-interval '1 day' where provider_id=$1`, identity.ProviderID)
			issuer := &fleetRecoveryIssuer{}
			service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, issuer)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewTLSServer(httpapi.NewRecorderFleetControllerRouter(service, fleetRecoveryVerifier{}, config.Key.Environment, nil))
			defer server.Close()
			control, err := recorderfleetcontrol.New(recorderfleetcontrol.Config{BaseURL: server.URL, HTTPClient: server.Client(), Key: config.Key})
			if err != nil {
				t.Fatal(err)
			}
			journal := &fleetRecoveryJournal{state: recorderfleet.NewJournal()}
			provider := &fleetRecoveryProvider{nodes: map[string]recorderfleet.Node{}}
			r, err := recorderfleet.NewReconciler(config, fleetRecoveryDemand{now: time.Now, desired: 1}, journal, provider, control, control)
			if err != nil {
				t.Fatal(err)
			}
			if result, err := r.Reconcile(t.Context()); err != nil || result.Action != recorderfleet.ActionIdentityRevoked {
				t.Fatalf("missing active row: %+v %v", result, err)
			}
			if result, err := r.Reconcile(t.Context()); err != nil || result.Action != recorderfleet.ActionCreatePlanned {
				t.Fatalf("missing row blocked replacement: %+v %v", result, err)
			}
			if issuer.revokes != 1 || provider.deletes != 0 || provider.gets != 1 {
				t.Fatalf("revoke/delete/exact-get=%d/%d/%d", issuer.revokes, provider.deletes, provider.gets)
			}
		})
	}
}

type fleetRecoveryIssuer struct{ revokes int }

func (*fleetRecoveryIssuer) EnsureBootstrap(context.Context, recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	return recorderfleet.NodeIdentity{}, recorderfleet.ErrProviderUnavailable
}
func (*fleetRecoveryIssuer) AbandonBootstrap(context.Context, recorderfleet.BootstrapRequest) error {
	return recorderfleet.ErrProviderUnavailable
}
func (i *fleetRecoveryIssuer) RevokeIdentity(context.Context, recorderfleet.NodeIdentity) error {
	i.revokes++
	return nil
}

type fleetRecoveryVerifier struct{}

func (fleetRecoveryVerifier) Verify(*http.Request) (recorderfleet.ControllerIdentity, error) {
	return recorderfleet.ControllerIdentity{}, nil
}

type fleetRecoveryDemand struct {
	now     func() time.Time
	desired int
}

func (d fleetRecoveryDemand) GetDemand(context.Context, recorderfleet.PoolKey) (recorderfleet.Demand, error) {
	return recorderfleet.Demand{Revision: "recovery", DesiredNodes: d.desired, ObservedAt: d.now()}, nil
}

type fleetRecoveryJournal struct{ state recorderfleet.Journal }

func (j *fleetRecoveryJournal) Load(context.Context, recorderfleet.PoolKey) (recorderfleet.Journal, error) {
	return j.state, nil
}
func (j *fleetRecoveryJournal) Save(_ context.Context, _ recorderfleet.PoolKey, _ uint64, state recorderfleet.Journal) (recorderfleet.Journal, error) {
	j.state = state
	return state, nil
}

type fleetRecoveryProvider struct {
	nodes         map[string]recorderfleet.Node
	deletes, gets int
}

func (p *fleetRecoveryProvider) ListNodes(context.Context, recorderfleet.PoolKey) ([]recorderfleet.Node, error) {
	nodes := []recorderfleet.Node{}
	for _, n := range p.nodes {
		nodes = append(nodes, n)
	}
	return nodes, nil
}
func (p *fleetRecoveryProvider) NodeExists(_ context.Context, _ recorderfleet.PoolKey, id string) (bool, error) {
	p.gets++
	_, ok := p.nodes[id]
	return ok, nil
}
func (*fleetRecoveryProvider) EnsureNode(context.Context, recorderfleet.EnsureNodeRequest) (recorderfleet.Node, error) {
	return recorderfleet.Node{}, recorderfleet.ErrProviderUnavailable
}
func (p *fleetRecoveryProvider) DeleteNode(_ context.Context, request recorderfleet.DeleteNodeRequest) error {
	p.deletes++
	delete(p.nodes, request.ProviderID)
	return nil
}
func fleetRecoveryConfig(role workeridentity.Role) recorderfleet.Config {
	digest := strings.Repeat("a", 64)
	return recorderfleet.Config{Key: recorderfleet.PoolKey{Environment: "recovery-test", Role: role}, OwnerTag: "chalk-recorder-owned", MaxNodes: 2, SlotsPerNode: 1, DemandMaxAge: time.Minute, ObservationMaxAge: 2 * time.Minute, StartupTimeout: 2 * time.Minute, DrainTimeout: time.Minute, HealthRefresh: 30 * time.Second, Now: time.Now,
		Release: recorderfleet.ReleaseSpec{ReleaseID: "release-test", ImageID: 1234, ImageDigest: "sha256:" + digest, Region: "sgp1", Size: "c-2", FirewallID: "firewall-test", BootstrapEndpoint: "https://bootstrap.example.test/v1/assertions", Archive: recorderfleet.ArchiveSpec{Bucket: "example-artifacts", Region: "ap-southeast-1", SHA256: digest, Key: "recorder/" + string(role) + "/" + digest + ".tar.gz"}}}
}
func fleetRecoveryNode(config recorderfleet.Config, id string) recorderfleet.Node {
	return recorderfleet.Node{ProviderID: id, Name: recorderfleet.NodeName(config.Key, config.Release.ReleaseID, 1), Status: "active", Region: config.Release.Region, Size: config.Release.Size, ImageID: config.Release.ImageID, BootGeneration: 1, CreatedAt: time.Now().Add(-time.Minute), Tags: recorderfleet.RequiredTags(config.Key, config.OwnerTag, config.Release, 1), FirewallIDs: []string{config.Release.FirewallID}}
}

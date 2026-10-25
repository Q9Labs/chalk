package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetcontrol"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestFleetRegisteredAtCreateFirstManagedClaimRequiresRow(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		t.Run(string(role), func(t *testing.T) {
			tx, fixture := newAllocationCleanupFixture(t, true, string(role))
			defer func() { _ = tx.Rollback(context.Background()) }()
			claimJobID := fixture.jobID
			if role == workeridentity.RoleCapture {
				var err error
				claimJobID, err = utilities.NewID()
				if err != nil {
					t.Fatal(err)
				}
				execCleanupFixture(t, tx, `insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider)
					select $2, tenant_id, space_id, episode_id, 'pending', storage_provider from recordings where id=$1`, fixture.recordingID.Bytes(), claimJobID.Bytes())
				execCleanupFixture(t, tx, `insert into recording_reservations (id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint, policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state, ends_at)
					select gen_random_uuid(), tenant_id, space_id, episode_id, $2, 'create-first-claim:' || $2::uuid::text, request_fingerprint, policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state, ends_at from recording_reservations where recording_id=$1`, fixture.recordingID.Bytes(), claimJobID.Bytes())
				execCleanupFixture(t, tx, `insert into recording_pipelines (recording_id, tenant_id, reservation_id, state)
					select recording_id, tenant_id, id, 'reserved' from recording_reservations where recording_id=$1`, claimJobID.Bytes())
				execCleanupFixture(t, tx, `insert into recording_jobs (id, tenant_id, episode_id, recording_id, kind, idempotency_key, payload_schema_version, state, available_at, attempt_limit)
					select $2, tenant_id, episode_id, $2, kind, 'create-first-claim:' || $2::uuid::text, 1, 'pending', now(), 3 from recording_jobs where id=$1`, fixture.jobID.Bytes(), claimJobID.Bytes())
			} else {
				prepareFleetRenderClaim(t, tx, fixture.jobID)
			}
			config := fleetRecoveryConfig(role)
			repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
			provider := &slotRegistrationProvider{fleetRecoveryProvider: &fleetRecoveryProvider{nodes: map[string]recorderfleet.Node{}}}
			service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, &slotRegistrationIssuer{provider: provider})
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
			r, err := recorderfleet.NewReconciler(config, fleetRecoveryDemand{now: time.Now, desired: 1}, journal, provider, control, control)
			if err != nil {
				t.Fatal(err)
			}
			step := func() {
				t.Helper()
				if _, err := r.Reconcile(t.Context()); err != nil && !errors.Is(err, recorderfleet.ErrBootstrapPending) {
					t.Fatal(err)
				}
			}
			step() // Persist create intent.
			step() // Register while the droplet is still new.
			var state string
			if err := tx.QueryRow(t.Context(), `select state from recording_fleet_nodes where environment=$1 and role=$2 and provider_id='1'`, config.Key.Environment, string(role)).Scan(&state); err != nil || state != "requested" || provider.nodes["1"].Status != "new" {
				t.Fatalf("row not reserved at create: state=%q error=%v", state, err)
			}
			node := provider.nodes["1"]
			node.Status = "active"
			provider.nodes["1"] = node
			for range 4 {
				if journal.state.Nodes["1"].Identity != nil {
					break
				}
				step()
			}
			identity := journal.state.Nodes["1"].Identity
			if identity == nil {
				t.Fatal("registered droplet never activated")
			}
			workerID, err := utilities.ParseID(identity.WorkerID)
			if err != nil {
				t.Fatal(err)
			}
			worker := workeridentity.Identity{WorkerID: workerID, Role: role}
			if _, err := service.RecordWorkerObservation(t.Context(), recorderfleetauthority.WorkerObservation{Identity: worker, Ready: true, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: time.Now()}); err != nil {
				t.Fatal(err)
			}
			if err := service.AuthorizeWorkerClaim(t.Context(), worker); err != nil {
				t.Fatal(err)
			}
			claim := func() (recordingpipeline.Job, error) {
				t.Helper()
				requestID, err := utilities.NewID()
				if err != nil {
					t.Fatal(err)
				}
				pipeline := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), judgeNestedClaimTransaction{tx}, nil)
				return pipeline.Claim(t.Context(), recordingpipeline.ClaimInput{ManagedWorker: true, ClaimRequestID: requestID, Kind: recordingpipeline.JobKind(role), Owner: identity.WorkerID, LeaseToken: "registered-first-claim", LeaseFor: time.Minute})
			}
			execCleanupFixture(t, tx, `savepoint missing_fleet_row`)
			execCleanupFixture(t, tx, `delete from recording_fleet_nodes where worker_id=$1`, workerID.Bytes())
			if _, err := claim(); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
				t.Fatalf("managed claim survived missing row: %v", err)
			}
			execCleanupFixture(t, tx, `rollback to savepoint missing_fleet_row`)
			job, err := claim()
			if err != nil || job.ID != claimJobID {
				t.Fatalf("first claim from create-time row: job=%s error=%v", job.ID, err)
			}
		})
	}
}

func TestFleetRegistersAtCreateAndRevokesStuckBootstrapWithPostgres(t *testing.T) {
	tx, _ := newAllocationCleanupFixture(t, true, "capture")
	defer func() { _ = tx.Rollback(context.Background()) }()
	config := fleetRecoveryConfig(workeridentity.RoleCapture)
	now := time.Now()
	config.Now = func() time.Time { return now }
	config.StartupTimeout, config.ObservationMaxAge = 10*time.Minute, 5*time.Minute
	repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
	provider := &slotRegistrationProvider{fleetRecoveryProvider: &fleetRecoveryProvider{nodes: map[string]recorderfleet.Node{}}, fail: true}
	issuer := &slotRegistrationIssuer{provider: provider}
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
	r, err := recorderfleet.NewReconciler(config, fleetRecoveryDemand{now: config.Now, desired: 2}, journal, provider, control, control)
	if err != nil {
		t.Fatal(err)
	}
	step := func() recorderfleet.Result {
		t.Helper()
		result, err := r.Reconcile(t.Context())
		if err != nil && !errors.Is(err, recorderfleet.ErrBootstrapPending) {
			t.Fatal(err)
		}
		return result
	}
	step() // Persist create intent.
	if _, err := r.Reconcile(t.Context()); err == nil {
		t.Fatal("failed provider create succeeded")
	}
	var rows int
	if err := tx.QueryRow(t.Context(), `select count(*) from recording_fleet_nodes where environment=$1`, config.Key.Environment).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("failed create left %d rows: %v", rows, err)
	}
	provider.fail = false
	if result := step(); result.Action != recorderfleet.ActionNodeEnsured {
		t.Fatalf("create: %+v", result)
	}
	var state string
	if err := tx.QueryRow(t.Context(), `select state from recording_fleet_nodes where environment=$1 and provider_id='1'`, config.Key.Environment).Scan(&state); err != nil || state != "requested" {
		t.Fatalf("new droplet not registered immediately: %s %v", state, err)
	}
	if provider.nodes["1"].Status != "new" {
		t.Fatal("test did not register before active")
	}
	// The first droplet stays new, but the second must still register and boot.
	for range 6 {
		step()
	}
	if err := tx.QueryRow(t.Context(), `select state from recording_fleet_nodes where environment=$1 and provider_id='2'`, config.Key.Environment).Scan(&state); err != nil || state != "active" {
		t.Fatalf("stuck create blocked sibling: %s %v", state, err)
	}
	now = now.Add(3 * time.Minute)
	for range 5 {
		step()
		if err := tx.QueryRow(t.Context(), `select state from recording_fleet_nodes where environment=$1 and provider_id='1'`, config.Key.Environment).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state == "revoked" {
			break
		}
	}
	if state != "revoked" {
		t.Fatalf("stuck create left row %s", state)
	}
	if issuer.abandons != 1 {
		t.Fatalf("stuck create did not fence certificate issuance: %d", issuer.abandons)
	}
}

type slotRegistrationProvider struct {
	*fleetRecoveryProvider
	fail bool
	next int
}

func (p *slotRegistrationProvider) EnsureNode(_ context.Context, request recorderfleet.EnsureNodeRequest) (recorderfleet.Node, error) {
	if p.fail {
		return recorderfleet.Node{}, recorderfleet.ErrProviderUnavailable
	}
	p.next++
	id := fmt.Sprint(p.next)
	node := recorderfleet.Node{ProviderID: id, Name: request.Name, Status: "active", Region: request.Release.Region, Size: request.Release.Size, ImageID: request.Release.ImageID, BootGeneration: request.BootGeneration, CreatedAt: time.Now(), Tags: request.RequiredTags, FirewallIDs: []string{request.Release.FirewallID}}
	if id == "1" {
		node.Status = "new"
	}
	p.nodes[id] = node
	return node, nil
}

type slotRegistrationIssuer struct {
	provider *slotRegistrationProvider
	abandons int
}

func (i *slotRegistrationIssuer) EnsureBootstrap(_ context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	if i.provider.nodes[request.ProviderID].Status != "active" {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrInventoryNotReady
	}
	id, err := utilities.NewID()
	if err != nil {
		return recorderfleet.NodeIdentity{}, err
	}
	return recorderfleet.NodeIdentity{ProviderID: request.ProviderID, WorkerID: id.String(), Role: request.Key.Role, BootGeneration: request.BootGeneration}, nil
}
func (i *slotRegistrationIssuer) AbandonBootstrap(context.Context, recorderfleet.BootstrapRequest) error {
	i.abandons++
	return nil
}
func (*slotRegistrationIssuer) RevokeIdentity(context.Context, recorderfleet.NodeIdentity) error {
	return nil
}

func TestFleetAbandonCannotRevokeIssuedIdentityWithPostgres(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, false, "capture")
	defer func() { _ = tx.Rollback(context.Background()) }()
	config := fleetRecoveryConfig(workeridentity.RoleCapture)
	node := fleetRecoveryNode(config, "issued")
	request := recorderfleet.BootstrapRequest{Key: config.Key, ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region, ReleaseID: config.Release.ReleaseID, ImageDigest: config.Release.ImageDigest, BootGeneration: node.BootGeneration, InventoryDigest: recorderfleet.InventoryDigest(node)}
	workerID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	identity := recorderfleet.NodeIdentity{ProviderID: node.ProviderID, WorkerID: workerID.String(), Role: config.Key.Role, BootGeneration: node.BootGeneration}
	repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
	if _, err := repository.ReserveBootstrap(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ActivateBootstrap(t.Context(), request, identity); err != nil {
		t.Fatal(err)
	}
	execCleanupFixture(t, tx, `update recording_jobs set lease_owner=$2, lease_expires_at=clock_timestamp()+interval '10 minutes' where id=$1`, fixture.jobID.Bytes(), workerID.String())
	if err := repository.AbandonBootstrap(t.Context(), request, time.Now()); err == nil {
		t.Fatal("abandon revoked an issued worker")
	}
	service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, &fleetRecoveryIssuer{})
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
	journal.state.NextBootGeneration = 2
	journal.state.Nodes[node.ProviderID] = recorderfleet.ManagedNode{ProviderID: node.ProviderID, Name: node.Name, BootGeneration: node.BootGeneration, Phase: recorderfleet.PhaseAwaitingBootstrap, PendingBootstrap: &request}
	provider := &fleetRecoveryProvider{nodes: map[string]recorderfleet.Node{}}
	r, err := recorderfleet.NewReconciler(config, fleetRecoveryDemand{now: time.Now}, journal, provider, control, control)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := r.Reconcile(t.Context()); err != nil || result.Action != recorderfleet.ActionBootstrapEnsured {
		t.Fatalf("lost response did not recover identity: %+v %v", result, err)
	}
	if _, err := r.Reconcile(t.Context()); err == nil {
		t.Fatal("provider 404 hid a live lease")
	}
	var state string
	if err := tx.QueryRow(t.Context(), `select state from recording_fleet_nodes where environment=$1 and provider_id=$2`, config.Key.Environment, node.ProviderID).Scan(&state); err != nil || state != "active" {
		t.Fatalf("lost response revoked live worker: %s %v", state, err)
	}
	// Once the database-live lease ends, the #490 path closes, samples, and revokes.
	execCleanupFixture(t, tx, `update recording_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1`, fixture.jobID.Bytes())
	for range 3 {
		if _, err := r.Reconcile(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.QueryRow(t.Context(), `select state from recording_fleet_nodes where environment=$1 and provider_id=$2`, config.Key.Environment, node.ProviderID).Scan(&state); err != nil || state != "revoked" {
		t.Fatalf("404 cleanup left active row: %s %v", state, err)
	}
}

func TestFleetSlotDemandSeparatesPhysicalNodeFloors(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, true, "capture")
	defer func() { _ = tx.Rollback(context.Background()) }()
	isolateFleetDemandFixture(t, tx, fixture)
	for range 9 {
		otherRecording, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		execCleanupFixture(t, tx, `insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider)
			select $2, tenant_id, space_id, episode_id, status, storage_provider from recordings where id=$1`, fixture.recordingID.Bytes(), otherRecording.Bytes())
		execCleanupFixture(t, tx, `insert into recording_reservations (id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint, policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state, ends_at)
			select gen_random_uuid(), tenant_id, space_id, episode_id, $2, 'floor:' || $2::uuid::text, request_fingerprint, policy_snapshot_version, 1, max_duration_seconds, 1000, state, ends_at from recording_reservations where recording_id=$1`, fixture.recordingID.Bytes(), otherRecording.Bytes())
	}
	repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
	for _, tc := range []struct{ participants, bitrate, floor int }{{100, 32000000, 3}, {10, 40000000, 3}, {10, 10000, 1}} {
		execCleanupFixture(t, tx, `update recording_reservations set participant_count=$2, input_bitrate_bps=$3 where episode_id=(select episode_id from recordings where id=$1)`, fixture.recordingID.Bytes(), tc.participants/10, tc.bitrate/10)
		demand, err := repository.GetDemand(t.Context(), fleetRecoveryConfig(workeridentity.RoleCapture).Key, time.Now())
		if err != nil || demand.CaptureCapacity == nil || demand.CaptureCapacity.SlotDemand != 10 || demand.CaptureCapacity.PhysicalNodeFloor != tc.floor || demand.DesiredNodes != max(10, tc.floor) {
			t.Fatalf("participants=%d bitrate=%d: demand=%+v capacity=%+v error=%v", tc.participants, tc.bitrate, demand, demand.CaptureCapacity, err)
		}
		if err := demand.Validate(); err != nil {
			t.Fatal(err)
		}
		if tc.participants != 100 {
			continue
		}
		config := fleetRecoveryConfig(workeridentity.RoleCapture)
		config.SlotsPerNode, config.MaxNodes = 8, 10
		service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, &fleetRecoveryIssuer{})
		if err != nil {
			t.Fatal(err)
		}
		provider := &fleetRecoveryProvider{nodes: map[string]recorderfleet.Node{}}
		journal := &fleetRecoveryJournal{state: recorderfleet.NewJournal()}
		journal.state.NextBootGeneration = 3
		for generation := uint64(1); generation <= 2; generation++ {
			node := fleetRecoveryNode(config, fmt.Sprint(generation))
			node.BootGeneration = generation
			node.Name = recorderfleet.NodeName(config.Key, config.Release.ReleaseID, generation)
			node.Tags = recorderfleet.RequiredTags(config.Key, config.OwnerTag, config.Release, generation)
			provider.nodes[node.ProviderID] = node
			workerID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			identity := recorderfleet.NodeIdentity{ProviderID: node.ProviderID, WorkerID: workerID.String(), Role: config.Key.Role, BootGeneration: generation}
			request := recorderfleet.BootstrapRequest{Key: config.Key, ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region, ReleaseID: config.Release.ReleaseID, ImageDigest: config.Release.ImageDigest, BootGeneration: generation, InventoryDigest: recorderfleet.InventoryDigest(node)}
			if _, err := repository.ReserveBootstrap(t.Context(), request); err != nil {
				t.Fatal(err)
			}
			if _, err := repository.ActivateBootstrap(t.Context(), request, identity); err != nil {
				t.Fatal(err)
			}
			ready := time.Now()
			if _, err := service.RecordWorkerObservation(t.Context(), recorderfleetauthority.WorkerObservation{Identity: workeridentity.Identity{WorkerID: workerID, Role: config.Key.Role}, Ready: true, AdmissionOpen: true, ReadyCapacity: 8, ObservedAt: ready}); err != nil {
				t.Fatal(err)
			}
			journal.state.Nodes[node.ProviderID] = recorderfleet.ManagedNode{ProviderID: node.ProviderID, Name: node.Name, BootGeneration: generation, Identity: &identity, Phase: recorderfleet.PhaseReady, LastReadyAt: &ready}
		}
		server := httptest.NewTLSServer(httpapi.NewRecorderFleetControllerRouter(service, fleetRecoveryVerifier{}, config.Key.Environment, nil))
		defer server.Close()
		control, err := recorderfleetcontrol.New(recorderfleetcontrol.Config{BaseURL: server.URL, HTTPClient: server.Client(), Key: config.Key})
		if err != nil {
			t.Fatal(err)
		}
		wire, err := control.GetDemand(t.Context(), config.Key)
		if err != nil || wire.CaptureCapacity == nil || *wire.CaptureCapacity != *demand.CaptureCapacity {
			t.Fatalf("capacity lost across HTTP: %+v %v", wire, err)
		}
		r, err := recorderfleet.NewReconciler(config, control, journal, provider, control, control)
		if err != nil {
			t.Fatal(err)
		}
		if result, err := r.Reconcile(t.Context()); err != nil || result.Action != recorderfleet.ActionCreatePlanned {
			t.Fatalf("ten Recordings / 100 participants / 32 Mbps / eight slots must retain three nodes: %+v %v", result, err)
		}
	}
}

func TestFleetSlotDemandPhysicalFloorWithPreparation(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, true, "capture")
	defer func() { _ = tx.Rollback(context.Background()) }()
	isolateFleetDemandFixture(t, tx, fixture)
	// Current admission limits each reservation to ten participants and 4 Mbps.
	// A transaction-local fixture lets the real query exercise resource-dominant
	// demand without changing those production limits or locking the shared table.
	execCleanupFixture(t, tx, `insert into recording_reservations select * from recording_reservations`)
	execCleanupFixture(t, tx, `update recording_reservations set participant_count=50, input_bitrate_bps=16000000`)
	execCleanupFixture(t, tx, `insert into recording_preparations (tenant_id, space_id, starts_at, state, revision, request_revision, request_kind)
		select tenant_id, space_id, clock_timestamp(), 'scheduled', 1, 1, 'prepare' from recordings where id=$1`, fixture.recordingID.Bytes())
	config := fleetRecoveryConfig(workeridentity.RoleCapture)
	repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
	service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, &fleetRecoveryIssuer{})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(httpapi.NewRecorderFleetControllerRouter(service, fleetRecoveryVerifier{}, config.Key.Environment, nil))
	defer server.Close()
	control, err := recorderfleetcontrol.New(recorderfleetcontrol.Config{BaseURL: server.URL, HTTPClient: server.Client(), Key: config.Key})
	if err != nil {
		t.Fatal(err)
	}
	demand, err := control.GetDemand(t.Context(), config.Key)
	if err != nil || demand.DesiredNodes != 4 || demand.ScheduledPrewarms != 1 || demand.CaptureCapacity == nil || demand.CaptureCapacity.SlotDemand != 3 || demand.CaptureCapacity.PhysicalNodeFloor != 3 {
		t.Fatalf("legacy demand adds a preparation; slot demand must not add a physical node: demand=%+v capacity=%+v error=%v", demand, demand.CaptureCapacity, err)
	}
}

func TestFleetSlotDemandUsesDatabaseLeaseClock(t *testing.T) {
	for _, expired := range []bool{false, true} {
		for _, skew := range []time.Duration{-time.Minute, time.Minute} {
			t.Run(fmt.Sprintf("expired=%v/skew=%s", expired, skew), func(t *testing.T) {
				tx, fixture := newAllocationCleanupFixture(t, expired, "capture")
				defer func() { _ = tx.Rollback(context.Background()) }()
				isolateFleetDemandFixture(t, tx, fixture)
				execCleanupFixture(t, tx, `update recording_reservations set ends_at=clock_timestamp()-interval '2 hours' where recording_id=$1`, fixture.recordingID.Bytes())
				delta := 30
				if expired {
					delta = -30
				}
				execCleanupFixture(t, tx, `update recording_jobs set lease_expires_at=clock_timestamp()+$2*interval '1 second' where id=$1`, fixture.jobID.Bytes(), delta)
				repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
				demand, err := repository.GetDemand(t.Context(), fleetRecoveryConfig(workeridentity.RoleCapture).Key, time.Now().Add(skew))
				want := 1
				if expired {
					want = 0
				}
				if err != nil || demand.DesiredNodes != want {
					t.Fatalf("demand=%+v want=%d err=%v", demand, want, err)
				}
			})
		}
	}
}

func isolateFleetDemandFixture(t *testing.T, tx pgx.Tx, fixture transcriptionAllocationCleanupFixture) {
	t.Helper()
	execCleanupFixture(t, tx, `create temporary table recording_reservations
        (like public.recording_reservations including defaults) on commit drop`)
	execCleanupFixture(t, tx, `insert into pg_temp.recording_reservations
        select * from public.recording_reservations where recording_id=$1`, fixture.recordingID.Bytes())
	execCleanupFixture(t, tx, `create temporary table recording_jobs
        (like public.recording_jobs including defaults) on commit drop`)
	execCleanupFixture(t, tx, `insert into pg_temp.recording_jobs
        select * from public.recording_jobs where id=$1`, fixture.jobID.Bytes())
	execCleanupFixture(t, tx, `create temporary table recording_preparations
        (like public.recording_preparations including defaults) on commit drop`)
	execCleanupFixture(t, tx, `set local search_path = pg_temp, public`)
}

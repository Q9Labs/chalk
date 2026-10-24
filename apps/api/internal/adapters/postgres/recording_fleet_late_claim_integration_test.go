package postgres_test

import (
	"context"
	"errors"
	"fmt"
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
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type judgeNestedClaimTransaction struct{ pgx.Tx }

func (tx judgeNestedClaimTransaction) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return tx.Tx.Begin(ctx)
}

type judgeLateClaimRuntime struct {
	*recorderfleetcontrol.Client
	reads     int
	afterZero func()
}

func (runtime *judgeLateClaimRuntime) ObserveIdentity(ctx context.Context, identity recorderfleet.NodeIdentity) (recorderfleet.NodeObservation, error) {
	observation, err := runtime.Client.ObserveIdentity(ctx, identity)
	runtime.reads++
	if err == nil && observation.ActiveLeases == 0 && runtime.reads == 2 {
		runtime.afterZero()
	}
	return observation, err
}

func TestJudgeMissingRowCannotRevokeAlreadyAuthorizedLateClaim(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, true, "render")
	defer func() { _ = tx.Rollback(context.Background()) }()
	config := fleetRecoveryConfig(workeridentity.RoleRender)
	workerID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	identity := recorderfleet.NodeIdentity{ProviderID: "live-late-claim", WorkerID: workerID.String(), Role: config.Key.Role, BootGeneration: 1}
	repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
	request := recorderfleet.BootstrapRequest{Key: config.Key, ProviderID: identity.ProviderID, NodeName: identity.ProviderID, Region: "sgp1", ReleaseID: config.Release.ReleaseID, ImageDigest: config.Release.ImageDigest, BootGeneration: 1, InventoryDigest: strings.Repeat("b", 64)}
	if _, err := repository.ReserveBootstrap(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ActivateBootstrap(t.Context(), request, identity); err != nil {
		t.Fatal(err)
	}
	execCleanupFixture(t, tx, `update recording_fleet_nodes set ready=true,admission_open=true,ready_capacity=1,observed_at=clock_timestamp() where provider_id=$1`, identity.ProviderID)
	// The real managed verifier's database authorization succeeds. Pause that
	// request before its transactional Claim, then lose the fleet row.
	if err := repository.AuthorizeWorkerClaim(t.Context(), config.Key.Environment, workeridentity.Identity{WorkerID: workerID, Role: identity.Role}); err != nil {
		t.Fatal(err)
	}
	execCleanupFixture(t, tx, `delete from recording_fleet_nodes where provider_id=$1`, identity.ProviderID)
	execCleanupFixture(t, tx, `update recording_jobs set state='pending',lease_owner=null,lease_token=null,lease_expires_at=null where id=$1`, fixture.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set state='render_queued',capture_ready_at=clock_timestamp()-interval '1 second' where recording_id=(select recording_id from recording_jobs where id=$1)`, fixture.jobID.Bytes())
	execCleanupFixture(t, tx, `insert into recording_data_keys (recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob) select job.recording_id,1,job.tenant_id,job.episode_id,job.id,1,1,input.key_handle,$2,input.envelope_digest,input.envelope_digest,decode('00','hex') from recording_jobs job join recording_render_inputs input on input.render_job_id=job.id where job.id=$1`, fixture.jobID.Bytes(), config.Key.Environment)
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
	runtime := &judgeLateClaimRuntime{Client: control}
	runtime.afterZero = func() {
		pipeline := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), judgeNestedClaimTransaction{tx}, nil)
		claimID, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		job, err := pipeline.Claim(t.Context(), recordingpipeline.ClaimInput{ManagedWorker: true, ClaimRequestID: claimID, Kind: recordingpipeline.JobKindRender, Owner: identity.WorkerID, LeaseToken: "judge-late-claim", LeaseFor: time.Minute})
		if !errors.Is(err, recordingpipeline.ErrJobNotFound) {
			t.Fatalf("late managed claim must be denied: job=%s error=%v", job.ID, err)
		}
		t.Log("late managed claim denied after the second zero sample")
	}
	node := fleetRecoveryNode(config, identity.ProviderID)
	provider := &fleetRecoveryProvider{nodes: map[string]recorderfleet.Node{node.ProviderID: node}}
	journal := &fleetRecoveryJournal{state: recorderfleet.NewJournal()}
	journal.state.NextBootGeneration = 2
	ready := time.Now()
	journal.state.Nodes[node.ProviderID] = recorderfleet.ManagedNode{ProviderID: node.ProviderID, Name: node.Name, Phase: recorderfleet.PhaseReady, BootGeneration: 1, Identity: &identity, LastReadyAt: &ready}
	reconciler, err := recorderfleet.NewReconciler(config, fleetRecoveryDemand{now: time.Now}, journal, provider, control, runtime)
	if err != nil {
		t.Fatal(err)
	}
	first, err := reconciler.Reconcile(t.Context())
	if err != nil || first.Action != recorderfleet.ActionAdmissionClosed {
		t.Fatalf("first drain: %+v %v", first, err)
	}
	second, err := reconciler.Reconcile(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	observation, err := repository.ObserveIdentity(t.Context(), config.Key.Environment, identity, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("after late claim: action=%s lease_count=%d certificate_revokes=%d db_revoked=%t", second.Action, observation.ActiveLeases, issuer.revokes, observation.IdentityRevoked)
	if observation.ActiveLeases != 0 || issuer.revokes != 1 || !observation.IdentityRevoked {
		t.Fatal("controller revoked a live identity after an unfenced missing-row zero sample")
	}
}

// The issuer is the external certificate boundary. Assert the durable reservation
// exists before it can publish a worker certificate, using the real repository.
type firstClaimIssuer struct {
	fleetRecoveryIssuer
	issue func(context.Context, recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error)
}

func (i *firstClaimIssuer) EnsureBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	return i.issue(ctx, request)
}

func TestRecordingFleetNewManagedWorkerFirstClaim(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, true, "render")
	defer func() { _ = tx.Rollback(context.Background()) }()
	prepareFleetRenderClaim(t, tx, fixture.jobID)
	config := fleetRecoveryConfig(workeridentity.RoleRender)
	workerID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	identity := recorderfleet.NodeIdentity{ProviderID: "first-claim", WorkerID: workerID.String(), Role: config.Key.Role, BootGeneration: 1}
	worker := workeridentity.Identity{WorkerID: workerID, Role: config.Key.Role}
	repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
	pipeline := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), judgeNestedClaimTransaction{tx}, nil)
	claim := func() (recordingpipeline.Job, error) {
		requestID, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return pipeline.Claim(t.Context(), recordingpipeline.ClaimInput{ManagedWorker: true, ClaimRequestID: requestID, Kind: recordingpipeline.JobKindRender, Owner: identity.WorkerID, LeaseToken: "first-claim", LeaseFor: time.Minute})
	}
	issued := false
	issuer := &firstClaimIssuer{issue: func(ctx context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
		var state string
		if err := tx.QueryRow(ctx, `select state from recording_fleet_nodes where environment=$1 and role=$2 and provider_id=$3`, config.Key.Environment, string(config.Key.Role), identity.ProviderID).Scan(&state); err != nil || state != "requested" {
			t.Fatalf("certificate issuance preceded bootstrap row: state=%q error=%v", state, err)
		}
		if _, err := claim(); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
			t.Fatalf("worker claimed before activation: %v", err)
		}
		issued = true
		t.Log("1: row reserved; 2: certificate issued")
		return identity, nil
	}}
	service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, issuer)
	if err != nil {
		t.Fatal(err)
	}
	request := recorderfleet.BootstrapRequest{Key: config.Key, ProviderID: identity.ProviderID, NodeName: identity.ProviderID, Region: "sgp1", ReleaseID: config.Release.ReleaseID, ImageDigest: config.Release.ImageDigest, BootGeneration: 1, InventoryDigest: strings.Repeat("b", 64)}
	if got, err := service.EnsureBootstrap(t.Context(), request); err != nil || got != identity || !issued {
		t.Fatalf("activate issued identity: %+v %v", got, err)
	}
	if err := service.AuthorizeWorker(t.Context(), worker); err != nil {
		t.Fatalf("activated worker not authenticated: %v", err)
	}
	if _, err := claim(); !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("worker claimed before ready heartbeat: %v", err)
	}
	if _, err := service.RecordWorkerObservation(t.Context(), recorderfleetauthority.WorkerObservation{Identity: worker, Ready: true, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := service.AuthorizeWorkerClaim(t.Context(), worker); err != nil {
		t.Fatalf("ready worker not authorized: %v", err)
	}
	job, err := claim()
	if err != nil || job.ID != fixture.jobID {
		t.Fatalf("first legitimate managed claim: job=%s error=%v", job.ID, err)
	}
	t.Log("3: identity activated; 4: ready heartbeat admitted; 5: first claim acquired a lease")
}

func TestRecordingFleetMissingRowExemptionOnlyForLocalOrLegacyClaims(t *testing.T) {
	for _, owner := range []string{"legacy-render", "77777777-7777-4777-8777-777777777777"} {
		for _, managed := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/managed=%t", owner, managed), func(t *testing.T) {
				tx, fixture := newAllocationCleanupFixture(t, true, "render")
				defer func() { _ = tx.Rollback(context.Background()) }()
				prepareFleetRenderClaim(t, tx, fixture.jobID)
				pipeline := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), judgeNestedClaimTransaction{tx}, nil)
				requestID, err := utilities.NewID()
				if err != nil {
					t.Fatal(err)
				}
				job, err := pipeline.Claim(t.Context(), recordingpipeline.ClaimInput{ManagedWorker: managed, ClaimRequestID: requestID, Kind: recordingpipeline.JobKindRender, Owner: owner, LeaseToken: "local-claim", LeaseFor: time.Minute})
				if managed {
					if !errors.Is(err, recordingpipeline.ErrJobNotFound) {
						t.Fatalf("managed missing row claimed: job=%s error=%v", job.ID, err)
					}
				} else if err != nil || job.ID != fixture.jobID {
					t.Fatalf("local/legacy missing row denied: job=%s error=%v", job.ID, err)
				}
			})
		}
	}
}

func prepareFleetRenderClaim(t *testing.T, tx pgx.Tx, jobID utilities.ID) {
	t.Helper()
	execCleanupFixture(t, tx, `update recording_jobs set state='pending',lease_owner=null,lease_token=null,lease_expires_at=null where id=$1`, jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set state='render_queued',capture_ready_at=clock_timestamp()-interval '1 second' where recording_id=(select recording_id from recording_jobs where id=$1)`, jobID.Bytes())
	execCleanupFixture(t, tx, `insert into recording_data_keys (recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob) select job.recording_id,1,job.tenant_id,job.episode_id,job.id,1,1,input.key_handle,'test',input.envelope_digest,input.envelope_digest,decode('00','hex') from recording_jobs job join recording_render_inputs input on input.render_job_id=job.id where job.id=$1`, jobID.Bytes())
}

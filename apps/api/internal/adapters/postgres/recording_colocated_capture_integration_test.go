package postgres_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	colocatedTestEnvironment = "nightly"
	colocatedTestGrace       = int32(20)
	fleetTestWorker          = "fleet-test-worker"
)

type colocatedScenario struct {
	tx      pgx.Tx
	queries *sqlc.Queries
	fixture transcriptionAllocationCleanupFixture
	node    string
	worker  string
}

// newColocatedScenario makes a pending capture on an Episode bound to a fresh own-SFU node, with
// a registered, ready colocated worker beside that node.
func newColocatedScenario(t *testing.T) colocatedScenario {
	t.Helper()
	tx, fixture := newAllocationCleanupFixture(t, false, "capture")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatal(err)
	}
	node := "sfu-" + hex.EncodeToString(suffix)
	execCleanupFixture(t, tx, `update recording_jobs set state='pending', lease_token=null, lease_owner=null, lease_expires_at=null, attempt_limit=10,
		available_at=now()-interval '1 second' where id=$1`, fixture.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set state='reserved', capture_completed_at=null where recording_id=$1`, fixture.recordingID.Bytes())
	workerID := workeridentity.ColocatedWorkerID(colocatedTestEnvironment, node)
	queries := sqlc.New(tx)
	if err := queries.EnsureRecordingColocatedCaptureWorker(t.Context(), sqlc.EnsureRecordingColocatedCaptureWorkerParams{
		Environment: colocatedTestEnvironment, SfuNode: node, WorkerID: cleanupUUID(workerID),
	}); err != nil {
		t.Fatalf("register colocated worker: %v", err)
	}
	s := colocatedScenario{tx: tx, queries: queries, fixture: fixture, node: node, worker: workerID.String()}
	s.setBinding(t, `update episodes set config_snapshot = config_snapshot ||
		jsonb_build_object('media_plane_binding', jsonb_build_object('provider','chalk_sfu','node',$2::text))
		where id=(select episode_id from recordings where id=$1)`, fixture.recordingID.Bytes(), node)
	s.reportWorker(t, "now()", true)
	return s
}

// setBinding rewrites the Episode's media plane binding, which the config_snapshot trigger
// otherwise refuses; the claim query only reads it.
func (s colocatedScenario) setBinding(t *testing.T, update string, args ...any) {
	t.Helper()
	execCleanupFixture(t, s.tx, `set local session_replication_role = replica`)
	execCleanupFixture(t, s.tx, update, args...)
	execCleanupFixture(t, s.tx, `set local session_replication_role = origin`)
}

func (s colocatedScenario) reportWorker(t *testing.T, observedAt string, open bool) {
	t.Helper()
	execCleanupFixture(t, s.tx, `update recording_colocated_capture_workers set ready=$2, admission_open=$2, ready_capacity=case when $2 then 2 else 0 end,
		observed_at=`+observedAt+` where sfu_node=$1`, s.node, open)
}

func (s colocatedScenario) claim(t *testing.T, owner string, grace int32) (sqlc.ClaimRecordingJobRow, error) {
	t.Helper()
	return s.queries.ClaimRecordingJob(t.Context(), sqlc.ClaimRecordingJobParams{
		LeaseOwner: owner, Kind: "capture", MaximumRenderSeconds: 7200, ColocatedGraceSeconds: grace, SupportsCompletionOnly: true,
		LeaseToken:     pgtype.Text{String: "colocated-lease-" + owner, Valid: true},
		LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true},
	})
}

func (s colocatedScenario) wantClaim(t *testing.T, owner string, grace int32) {
	t.Helper()
	claimed, err := s.claim(t, owner, grace)
	if err != nil {
		t.Fatalf("%s claim with grace %d: %v", owner, grace, err)
	}
	if claimed.ID.Bytes != s.fixture.jobID.Bytes() {
		t.Fatalf("%s claimed another job", owner)
	}
}

func (s colocatedScenario) wantNoClaim(t *testing.T, owner string, grace int32) {
	t.Helper()
	if _, err := s.claim(t, owner, grace); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("%s claim with grace %d = %v, want no job", owner, grace, err)
	}
}

// failAttempt records the claim's placement the way the repository does in the claim transaction
// (InsertRecordingJobAttemptAuthority), then ends the attempt: the worker reported a failure or its
// lease lapsed, so the job is pending again and available now.
func (s colocatedScenario) failAttempt(t *testing.T, claimed sqlc.ClaimRecordingJobRow, owner string) {
	t.Helper()
	requestID := make([]byte, 16)
	if _, err := rand.Read(requestID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.queries.InsertRecordingJobAttemptAuthority(t.Context(), sqlc.InsertRecordingJobAttemptAuthorityParams{
		JobID: claimed.ID, AttemptCount: claimed.AttemptCount, FencingGeneration: claimed.FencingGeneration, CaptureEpoch: 1,
		ClaimRequestID: pgtype.UUID{Bytes: [16]byte(requestID), Valid: true}, Kind: "capture", LeaseOwner: owner,
		LeaseToken: "colocated-lease-" + owner, LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Minute), Valid: true},
		EnvelopeBytes: []byte("{}"), EnvelopeDigest: make([]byte, 32), IssuedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	}); err != nil {
		t.Fatalf("record attempt authority: %v", err)
	}
	execCleanupFixture(t, s.tx, `update recording_jobs set state='pending', lease_token=null, lease_owner=null, lease_expires_at=null,
		available_at=now()-interval '1 second' where id=$1`, s.fixture.jobID.Bytes())
	execCleanupFixture(t, s.tx, `update recording_pipelines set state='retryable_failure' where recording_id=$1`, s.fixture.recordingID.Bytes())
}

func TestColocatedCaptureClaimPlacement(t *testing.T) {
	t.Run("healthy worker takes its node's capture and the fleet waits", func(t *testing.T) {
		s := newColocatedScenario(t)
		s.wantNoClaim(t, fleetTestWorker, colocatedTestGrace)
		s.wantClaim(t, s.worker, colocatedTestGrace)
	})
	t.Run("switch off keeps the on-demand path", func(t *testing.T) {
		s := newColocatedScenario(t)
		s.wantNoClaim(t, s.worker, 0)
		s.wantClaim(t, fleetTestWorker, 0)
	})
	t.Run("the fleet takes the capture when the worker is not healthy", func(t *testing.T) {
		for name, report := range map[string]func(*testing.T, colocatedScenario){
			"stale report": func(t *testing.T, s colocatedScenario) { s.reportWorker(t, "now()-interval '2 minutes'", true) },
			"closed":       func(t *testing.T, s colocatedScenario) { s.reportWorker(t, "now()", false) },
		} {
			t.Run(name, func(t *testing.T) {
				s := newColocatedScenario(t)
				report(t, s)
				s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
			})
		}
	})
	t.Run("the fleet takes the capture once the grace has passed", func(t *testing.T) {
		s := newColocatedScenario(t)
		execCleanupFixture(t, s.tx, `update recording_jobs set available_at=now()-interval '1 minute' where id=$1`, s.fixture.jobID.Bytes())
		s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
	})
	t.Run("a worker never takes another node's capture", func(t *testing.T) {
		s := newColocatedScenario(t)
		s.setBinding(t, `update episodes set config_snapshot = jsonb_set(config_snapshot, '{media_plane_binding,node}', '"other-node"')
			where id=(select episode_id from recordings where id=$1)`, s.fixture.recordingID.Bytes())
		s.wantNoClaim(t, s.worker, colocatedTestGrace)
	})
	t.Run("a Cloudflare-plane capture stays with the fleet", func(t *testing.T) {
		s := newColocatedScenario(t)
		s.setBinding(t, `update episodes set config_snapshot = config_snapshot - 'media_plane_binding'
			where id=(select episode_id from recordings where id=$1)`, s.fixture.recordingID.Bytes())
		s.wantNoClaim(t, s.worker, colocatedTestGrace)
		s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
	})
}

func TestColocatedCaptureDemandAndObservations(t *testing.T) {
	s := newColocatedScenario(t)
	demand := func(grace int32) sqlc.GetRecordingFleetDemandRow {
		row, err := s.queries.GetRecordingFleetDemand(t.Context(), sqlc.GetRecordingFleetDemandParams{
			Role: "capture", ObservedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
			ColocatedGraceSeconds: grace, OwnCapture: true, RecordingCap: 100,
		})
		if err != nil {
			t.Fatalf("fleet demand with grace %d: %v", grace, err)
		}
		return row
	}
	off, on := demand(0), demand(colocatedTestGrace)
	if on.QueuedJobs != off.QueuedJobs-1 || on.HeldStarts != off.HeldStarts-1 {
		t.Errorf("a capture held for a healthy colocated worker still counts: queued %d→%d, held starts %d→%d", off.QueuedJobs, on.QueuedJobs, off.HeldStarts, on.HeldStarts)
	}
	s.reportWorker(t, "now()-interval '2 minutes'", true)
	if stale := demand(colocatedTestGrace); stale.QueuedJobs != off.QueuedJobs || stale.HeldStarts != off.HeldStarts {
		t.Errorf("a capture the unhealthy worker cannot take must count again: queued %d→%d, held starts %d→%d", off.QueuedJobs, stale.QueuedJobs, off.HeldStarts, stale.HeldStarts)
	}

	observation, err := s.queries.RecordRecordingColocatedWorkerObservation(t.Context(), sqlc.RecordRecordingColocatedWorkerObservationParams{
		Ready: true, AdmissionOpen: true, ReadyCapacity: 2, Environment: colocatedTestEnvironment, Role: "capture",
		WorkerID: cleanupUUID(workeridentity.ColocatedWorkerID(colocatedTestEnvironment, s.node)),
	})
	if err != nil || observation.ProviderID != "sfu:"+s.node || !observation.Ready {
		t.Fatalf("colocated worker observation = %+v, %v", observation, err)
	}

	nodes, err := s.queries.ListRecordingFleetNodeObservations(t.Context(), sqlc.ListRecordingFleetNodeObservationsParams{Environment: colocatedTestEnvironment, Role: "capture"})
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range nodes {
		if node.ProviderID == "sfu:"+s.node {
			t.Errorf("the fleet reconciler must not see the colocated worker %q", node.ProviderID)
		}
	}
}

func TestColocatedCaptureWorkerAuthorization(t *testing.T) {
	s := newColocatedScenario(t)
	// The switch gates new claims only: a worker that holds a lease keeps authorizing its heartbeats
	// and commits with the switch off.
	authorizedWorker := func() bool {
		ok, err := s.queries.AuthorizeRecordingFleetWorker(t.Context(), sqlc.AuthorizeRecordingFleetWorkerParams{
			Environment: colocatedTestEnvironment, Role: "capture", WorkerID: cleanupUUID(workeridentity.ColocatedWorkerID(colocatedTestEnvironment, s.node)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	claimGate := func(enabled bool) (claim, closed bool) {
		row, err := s.queries.AuthorizeRecordingFleetWorkerClaim(t.Context(), sqlc.AuthorizeRecordingFleetWorkerClaimParams{
			Environment: colocatedTestEnvironment, Role: "capture", ColocatedEnabled: enabled,
			WorkerID: cleanupUUID(workeridentity.ColocatedWorkerID(colocatedTestEnvironment, s.node)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return row.Authorized, row.AdmissionClosed
	}
	lockGate := func(enabled bool) bool {
		ok, err := s.queries.LockRecordingFleetWorkerClaim(t.Context(), sqlc.LockRecordingFleetWorkerClaimParams{Role: "capture", ColocatedEnabled: enabled, LeaseOwner: s.worker})
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !authorizedWorker() {
		t.Error("a registered colocated worker must be authorized on its worker routes")
	}
	if claim, _ := claimGate(true); !claim || !lockGate(true) {
		t.Error("a ready colocated worker must be authorized to claim while the switch is on")
	}
	if claim, closed := claimGate(false); claim || !closed || lockGate(false) {
		t.Errorf("with the switch off the worker must not claim and must see admission closed: claim=%v closed=%v lock=%v", claim, closed, lockGate(false))
	}
	if !authorizedWorker() {
		t.Error("switching colocation off must not cut a running worker off its heartbeat and commit routes")
	}

	var legacy int
	if err := s.tx.QueryRow(t.Context(), `select count(*) from recording_fleet_nodes where worker_id=$1 or provider_id like 'sfu:%'`,
		workeridentity.ColocatedWorkerID(colocatedTestEnvironment, s.node).String()).Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	if legacy != 0 {
		t.Errorf("the legacy fleet registry holds %d colocated rows; earlier releases read it as the DigitalOcean fleet", legacy)
	}

	execCleanupFixture(t, s.tx, `update recording_colocated_capture_workers set state='revoked', ready=false, admission_open=false, ready_capacity=0, revoked_at=now() where sfu_node=$1`, s.node)
	if err := s.queries.EnsureRecordingColocatedCaptureWorker(t.Context(), sqlc.EnsureRecordingColocatedCaptureWorkerParams{
		Environment: colocatedTestEnvironment, SfuNode: s.node, WorkerID: cleanupUUID(workeridentity.ColocatedWorkerID(colocatedTestEnvironment, s.node)),
	}); err != nil {
		t.Fatal(err)
	}
	if authorizedWorker() || lockGate(true) {
		t.Error("registering again must not reactivate a revoked colocated worker")
	}
}

func TestColocatedCaptureClaimedEvent(t *testing.T) {
	s := newColocatedScenario(t)
	execCleanupFixture(t, s.tx, `update recording_jobs set available_at=now()-interval '3 seconds' where id=$1`, s.fixture.jobID.Bytes())
	s.wantClaim(t, s.worker, colocatedTestGrace)
	if err := s.queries.InsertRecordingClaimedEvent(t.Context(), sqlc.InsertRecordingClaimedEventParams{JobID: cleanupUUID(s.fixture.jobID), LeaseOwner: s.worker}); err != nil {
		t.Fatalf("record claim: %v", err)
	}
	var placement string
	var lagMillis int64
	err := s.tx.QueryRow(t.Context(), `select attributes->>'placement', (attributes->>'claim_lag_ms')::bigint from observability_journey_events
		where name='recording.claimed' and attributes->>'job_id'=$1::uuid::text`, s.fixture.jobID.String()).Scan(&placement, &lagMillis)
	if err != nil {
		t.Fatalf("read recording.claimed: %v", err)
	}
	if placement != "colocated" || lagMillis < 3000 {
		t.Errorf("recording.claimed placement=%q claim_lag_ms=%d, want colocated and at least 3000", placement, lagMillis)
	}
}

// A capture attempt on the colocated worker ends when its node dies, its process dies or it
// reports a failure. The next attempt goes to the fleet at once and never back to the colocated
// worker, whatever its health, so a worker that reports ready but cannot capture cannot use up the
// job's attempts alone.
func TestColocatedCaptureFailedAttemptGoesToFleet(t *testing.T) {
	failFirst := func(t *testing.T, s colocatedScenario) {
		t.Helper()
		claimed, err := s.claim(t, s.worker, colocatedTestGrace)
		if err != nil {
			t.Fatalf("colocated claim: %v", err)
		}
		s.failAttempt(t, claimed, s.worker)
	}
	t.Run("worker still reports ready: the fleet takes the next attempt without waiting for the grace", func(t *testing.T) {
		s := newColocatedScenario(t)
		failFirst(t, s)
		s.wantNoClaim(t, s.worker, colocatedTestGrace)
		s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
	})
	t.Run("node died: reports stopped and the fleet takes it", func(t *testing.T) {
		s := newColocatedScenario(t)
		failFirst(t, s)
		s.reportWorker(t, "now()-interval '2 minutes'", true)
		s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
	})
	t.Run("the failed attempt's job counts as fleet demand again", func(t *testing.T) {
		s := newColocatedScenario(t)
		demand := func() int32 {
			row, err := s.queries.GetRecordingFleetDemand(t.Context(), sqlc.GetRecordingFleetDemandParams{
				Role: "capture", ObservedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
				ColocatedGraceSeconds: colocatedTestGrace, OwnCapture: true, RecordingCap: 100,
			})
			if err != nil {
				t.Fatal(err)
			}
			return row.QueuedJobs
		}
		held := demand()
		failFirst(t, s)
		if after := demand(); after != held+1 {
			t.Errorf("queued jobs %d→%d: a capture the colocated worker failed must count for the fleet", held, after)
		}
	})
	t.Run("a repeat failure on the fleet leaves the retries with the fleet", func(t *testing.T) {
		s := newColocatedScenario(t)
		failFirst(t, s)
		claimed, err := s.claim(t, fleetTestWorker, colocatedTestGrace)
		if err != nil {
			t.Fatalf("fleet claim: %v", err)
		}
		s.failAttempt(t, claimed, fleetTestWorker)
		s.wantNoClaim(t, s.worker, colocatedTestGrace)
		s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
	})
}

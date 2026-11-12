package postgres_test

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

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

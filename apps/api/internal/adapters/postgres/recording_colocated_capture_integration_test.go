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
	execCleanupFixture(t, tx, `update recording_jobs set state='pending', lease_token=null, lease_owner=null, lease_expires_at=null,
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
	execCleanupFixture(t, s.tx, `update recording_fleet_nodes set ready=$2, admission_open=$2, ready_capacity=case when $2 then 2 else 0 end,
		observed_at=`+observedAt+` where colocated_sfu_node=$1`, s.node, open)
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
	authorized := func(enabled bool) bool {
		ok, err := s.queries.LockRecordingFleetWorkerClaim(t.Context(), sqlc.LockRecordingFleetWorkerClaimParams{Role: "capture", ColocatedEnabled: enabled, LeaseOwner: s.worker})
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !authorized(true) {
		t.Error("a ready colocated worker must be authorized while the switch is on")
	}
	if authorized(false) {
		t.Error("a colocated worker must not be authorized while the switch is off")
	}
	execCleanupFixture(t, s.tx, `update recording_fleet_nodes set state='revoked', ready=false, admission_open=false, ready_capacity=0, revoked_at=now() where colocated_sfu_node=$1`, s.node)
	if err := s.queries.EnsureRecordingColocatedCaptureWorker(t.Context(), sqlc.EnsureRecordingColocatedCaptureWorkerParams{
		Environment: colocatedTestEnvironment, SfuNode: s.node, WorkerID: cleanupUUID(workeridentity.ColocatedWorkerID(colocatedTestEnvironment, s.node)),
	}); err != nil {
		t.Fatal(err)
	}
	if authorized(true) {
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

// A capture the colocated worker holds is lost when its node dies or the worker process dies. The
// lease lapses and recovery requeues the job; the fleet must then be able to take it, at once when
// the worker's reports have stopped (the node is gone) and after the grace when the worker is
// still reporting (the process came back).
func TestColocatedCaptureLeaseLapse(t *testing.T) {
	lapse := func(t *testing.T, s colocatedScenario) {
		t.Helper()
		s.wantClaim(t, s.worker, colocatedTestGrace)
		execCleanupFixture(t, s.tx, `update recording_jobs set lease_expires_at=now()-interval '1 second' where id=$1`, s.fixture.jobID.Bytes())
		if _, err := s.queries.RecoverExpiredRecordingJobs(t.Context(), 7200); err != nil {
			t.Fatalf("recover expired jobs: %v", err)
		}
		execCleanupFixture(t, s.tx, `update recording_jobs set available_at=now()-interval '1 second' where id=$1`, s.fixture.jobID.Bytes())
	}
	t.Run("node dies: reports stop and the fleet takes the capture at once", func(t *testing.T) {
		s := newColocatedScenario(t)
		lapse(t, s)
		s.reportWorker(t, "now()-interval '2 minutes'", true)
		s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
	})
	t.Run("worker process dies and returns: it keeps the capture, the fleet waits out the grace", func(t *testing.T) {
		s := newColocatedScenario(t)
		lapse(t, s)
		s.wantNoClaim(t, fleetTestWorker, colocatedTestGrace)
		s.wantClaim(t, s.worker, colocatedTestGrace)
	})
	t.Run("worker process dies and does not return: the fleet takes the capture after the grace", func(t *testing.T) {
		s := newColocatedScenario(t)
		lapse(t, s)
		execCleanupFixture(t, s.tx, `update recording_jobs set available_at=now()-interval '1 minute' where id=$1`, s.fixture.jobID.Bytes())
		s.wantClaim(t, fleetTestWorker, colocatedTestGrace)
	})
}

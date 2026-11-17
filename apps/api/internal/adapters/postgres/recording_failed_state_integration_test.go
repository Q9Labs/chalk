package postgres_test

import (
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingFacts struct {
	status        string
	failureCode   *string
	hasFailedAt   bool
	pipelineState string
	mediaBundles  *int
	gapBundles    *int
}

func readRecordingFacts(t *testing.T, tx pgx.Tx, recordingID utilities.ID) recordingFacts {
	t.Helper()
	var facts recordingFacts
	err := tx.QueryRow(t.Context(), `select recordings.status, recordings.failure_code, recordings.failed_at is not null,
			pipelines.state, pipelines.capture_media_bundle_count, pipelines.capture_gap_bundle_count
		from recordings join recording_pipelines pipelines on pipelines.recording_id = recordings.id
		where recordings.id = $1`, recordingID.Bytes()).
		Scan(&facts.status, &facts.failureCode, &facts.hasFailedAt, &facts.pipelineState, &facts.mediaBundles, &facts.gapBundles)
	if err != nil {
		t.Fatal(err)
	}
	return facts
}

func transactionalPipelineRepository(tx pgx.Tx) postgres.RecordingPipelineRepository {
	return postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), captureRetryTransaction{tx}, nil)
}

const insertGapBundle = `insert into recording_bundles(id,tenant_id,recording_id,capture_job_id,sequence_number,fencing_generation,object_key,content_type,codec,byte_size,checksum,monotonic_start_millis,monotonic_end_millis,media_start_millis,media_end_millis)
	select gen_random_uuid(),tenant_id,recording_id,capture_job_id,99,fencing_generation,'fixture/gap','application/octet-stream','gap',1,checksum,1000,2000,1000,2000
	from recording_bundles where recording_id = $1 and codec <> 'gap' limit 1`

// The fixture's Recording is already completed; a capture in flight is pending.
func startEmptyCapture(t *testing.T, tx pgx.Tx, recordingID utilities.ID, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		execCleanupFixture(t, tx, statement, recordingID.Bytes())
	}
	execCleanupFixture(t, tx, `update recordings set status = 'pending' where id = $1`, recordingID.Bytes())
}

// A capture whose committed bundles hold no media is a failure with its own code, not a ready
// Recording that renders nothing.
func TestCaptureWithoutMediaFailsTheRecordingAsEmpty(t *testing.T) {
	for name, statements := range map[string][]string{
		"no bundles":       {`delete from recording_bundles where recording_id = $1`},
		"only gap bundles": {insertGapBundle, `delete from recording_bundles where recording_id = $1 and codec <> 'gap'`},
	} {
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			tx, f, lease := newStoppedCompletionFixture(t)
			defer tx.Rollback(ctx)
			startEmptyCapture(t, tx, f.recordingID, statements...)

			job, err := transactionalPipelineRepository(tx).CompleteCapture(ctx, lease, f.recordingID)
			if err != nil {
				t.Fatalf("complete empty capture: %v", err)
			}
			if job.State != recordingpipeline.JobStateTerminalFailure || job.ErrorCode == nil || *job.ErrorCode != recordingpipeline.ErrorCodeCaptureEmpty {
				t.Fatalf("empty capture must end terminal as %s: state=%s code=%v", recordingpipeline.ErrorCodeCaptureEmpty, job.State, job.ErrorCode)
			}
			facts := readRecordingFacts(t, tx, f.recordingID)
			if facts.status != "failed" || facts.failureCode == nil || *facts.failureCode != recordingpipeline.ErrorCodeCaptureEmpty || !facts.hasFailedAt || facts.pipelineState != "terminal_failure" {
				t.Fatalf("recording must say it failed as empty: %+v", facts)
			}
			var events int
			if err := tx.QueryRow(ctx, `select count(*) from observability_journey_events
				where name = 'recording.failed' and attributes->>'recording_id' = $1 and attributes->>'failure_code' = $2`,
				f.recordingID.String(), recordingpipeline.ErrorCodeCaptureEmpty).Scan(&events); err != nil || events != 1 {
				t.Fatalf("the Episode journey must show the failure once: events=%d err=%v", events, err)
			}
		})
	}
}

// Leaving terminal_failure through a retry puts the Recording back in flight and clears its failure.
func TestRecordingFailureClearsWhenTheRetryReopensThePipeline(t *testing.T) {
	ctx := t.Context()
	tx, f, lease := newStoppedCompletionFixture(t)
	defer tx.Rollback(ctx)
	startEmptyCapture(t, tx, f.recordingID, `delete from recording_bundles where recording_id = $1`)
	if _, err := transactionalPipelineRepository(tx).CompleteCapture(ctx, lease, f.recordingID); err != nil {
		t.Fatal(err)
	}
	if facts := readRecordingFacts(t, tx, f.recordingID); facts.status != "failed" {
		t.Fatalf("setup: recording must be failed: %+v", facts)
	}

	execCleanupFixture(t, tx, `update recording_pipelines set state = 'capture_complete' where recording_id = $1`, f.recordingID.Bytes())
	facts := readRecordingFacts(t, tx, f.recordingID)
	if facts.status != "pending" || facts.failureCode != nil || facts.hasFailedAt {
		t.Fatalf("a reopened pipeline must clear the failure: %+v", facts)
	}
}

// Completing a capture with media records what it held, and the Recording stays in flight.
func TestCaptureCompletionStoresBundleCounts(t *testing.T) {
	ctx := t.Context()
	tx, f, lease := newStoppedCompletionFixture(t)
	defer tx.Rollback(ctx)
	execCleanupFixture(t, tx, insertGapBundle, f.recordingID.Bytes())

	if _, err := postgres.NewRecordingPipelineRepository(sqlc.New(tx)).CompleteCapture(ctx, lease, f.recordingID); err != nil {
		t.Fatalf("complete capture: %v", err)
	}
	facts := readRecordingFacts(t, tx, f.recordingID)
	if facts.mediaBundles == nil || facts.gapBundles == nil || *facts.mediaBundles != 1 || *facts.gapBundles != 1 {
		t.Fatalf("completion must store one media and one gap bundle: %+v media=%v gap=%v", facts, facts.mediaBundles, facts.gapBundles)
	}
}

// A lease that runs out never reaches Fail. Recovery writes the attempt's failure row itself, and a
// terminal recovery fails the Recording with the job's code.
func TestExpiredCaptureLeaseLeavesAnAttemptFailure(t *testing.T) {
	ctx := t.Context()
	tx, f := newAllocationCleanupFixture(t, true, "capture")
	defer tx.Rollback(ctx)
	execCleanupFixture(t, tx, `update recording_jobs set attempt_limit = 1 where id = $1`, f.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_capacity set reserved_episodes = reserved_episodes + 1,
		reserved_participants = reserved_participants + 1, reserved_input_bitrate_bps = reserved_input_bitrate_bps + 1000 where id = 1`)
	execCleanupFixture(t, tx, `update recordings set status = 'pending' where id = $1`, f.recordingID.Bytes())

	recovered, err := transactionalPipelineRepository(tx).RecoverExpired(ctx)
	if err != nil {
		t.Fatalf("recover expired: %v", err)
	}
	var failures int
	var code, owner string
	if err := tx.QueryRow(ctx, `select count(*), coalesce(max(error_code), ''), coalesce(max(lease_owner), '')
		from recording_job_attempt_failures where job_id = $1`, f.jobID.Bytes()).Scan(&failures, &code, &owner); err != nil {
		t.Fatal(err)
	}
	if failures != 1 || code == "" || owner != f.leaseOwner {
		t.Fatalf("expired lease must record its attempt: jobs=%d failures=%d code=%q owner=%q", len(recovered), failures, code, owner)
	}
	facts := readRecordingFacts(t, tx, f.recordingID)
	if facts.status != "failed" || facts.failureCode == nil || *facts.failureCode != code {
		t.Fatalf("terminal recovery must fail the recording with the job code %q: %+v", code, facts)
	}
}

// The claim carries the Episode journey the Recording started under, and falls back to the
// Recording id when no start operation named one.
func TestStartCorrelationJoinsTheEpisodeJourney(t *testing.T) {
	ctx := t.Context()
	tx, f, _ := newStoppedCompletionFixture(t)
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)

	fallback, err := queries.GetRecordingStartCorrelation(ctx, cleanupUUID(f.jobID))
	if err != nil {
		t.Fatal(err)
	}
	if utilities.IDFromBytes(fallback.JourneyID.Bytes) != f.recordingID || fallback.TraceID.Valid {
		t.Fatalf("a start without a journey falls back to the recording id: %+v", fallback)
	}

	journeyID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	const traceID = "0af7651916cd43dd8448eb211c80319c"
	execCleanupFixture(t, tx, `update sync_external_operations set journey_id = $2, parent_journey_event_id = gen_random_uuid(), producing_trace_id = $3, producing_span_id = '00f067aa0ba902b7'
		where recording_id = $1 and operation_name = 'start_recording'`, f.recordingID.Bytes(), journeyID.Bytes(), traceID)
	joined, err := queries.GetRecordingStartCorrelation(ctx, cleanupUUID(f.jobID))
	if err != nil {
		t.Fatal(err)
	}
	if utilities.IDFromBytes(joined.JourneyID.Bytes) != journeyID || joined.TraceID.String != traceID {
		t.Fatalf("claim must carry the start operation's journey and trace: %+v", joined)
	}
}

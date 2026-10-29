package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/recordingorchestrator"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Sync invokes this probe against committed fixtures to exercise the actual Go
// controller and maintenance commands, not a second implementation of their SQL.
func TestRecordingStopLifecycleProbe(t *testing.T) {
	action := os.Getenv("CHALK_RECORDING_STOP_PROBE_ACTION")
	if action == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("CHALK_SYNC_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	parse := func(name string) utilities.ID {
		id, err := utilities.ParseID(os.Getenv(name))
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	tenantID := parse("CHALK_STOP_TENANT_ID")
	episodeID := parse("CHALK_STOP_EPISODE_ID")
	recordingID := parse("CHALK_STOP_RECORDING_ID")
	service := recordingpipeline.NewService(NewRecordingPipelineRepositoryWithPool(pool))
	controller := recordingorchestrator.NewController(service)
	switch action {
	case "seed", "capture":
		_, err = service.Materialize(ctx, recordingpipeline.ReservationInput{
			TenantID: tenantID, SpaceID: parse("CHALK_STOP_SPACE_ID"), EpisodeID: episodeID, RecordingID: recordingID,
			IdempotencyKey: "stop-recovery-" + recordingID.String(), PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
			ParticipantCount: 1, MaxDuration: time.Hour, InputBitrateBPS: 1000000,
		})
		if err != nil {
			t.Fatal(err)
		}
		if action == "capture" {
			claimID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			job, err := service.Claim(ctx, recordingpipeline.ClaimInput{
				ClaimRequestID: claimID, Kind: recordingpipeline.JobKindCapture,
				Owner: "late-stop-probe", LeaseToken: "late-stop-lease", LeaseFor: 10 * time.Minute,
			})
			if err != nil || job.RecordingID != recordingID || job.Authority == nil {
				t.Fatalf("claim finishing capture = %+v, error = %v", job, err)
			}
			return
		}
		_, err = service.RequestStop(ctx, tenantID, episodeID, recordingID, parse("CHALK_STOP_OPERATION_ID"))
		if err != nil {
			t.Fatal(err)
		}
		_, err = pool.Exec(ctx, `with completed as (
            update recording_pipelines set state='capture_complete', capture_epoch=2,
                capture_completed_at=now() where tenant_id=$1 and recording_id=$2 returning recording_id
        ), succeeded as (
            update recording_jobs set state='succeeded',terminal_at=now()
            where recording_id in (select recording_id from completed) and kind='capture' returning recording_id
        ), released as (
            update recording_reservations set state='released'
            where recording_id in (select recording_id from succeeded) and state='reserved'
            returning participant_count,input_bitrate_bps
        ) update recording_capacity set reserved_episodes=reserved_episodes-1,
            reserved_participants=reserved_participants-released.participant_count,
            reserved_input_bitrate_bps=reserved_input_bitrate_bps-released.input_bitrate_bps
        from released where recording_capacity.id=1`, tenantID.Bytes(), recordingID.Bytes())
	case "stop", "conflict":
		err = controller.Stop(ctx, provideroperations.OperationInput{
			OperationID: os.Getenv("CHALK_STOP_OPERATION_ID"), Effect: provideroperations.EffectStopRecording,
			TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID,
		})
		if action == "conflict" {
			if !errors.Is(err, recordingpipeline.ErrStopConflict) {
				t.Fatalf("stop error = %v, want conflict", err)
			}
			return
		}
	case "reconcile":
		_, err = service.RecoverExpired(ctx)
	case "callback", "complete":
		authority := recordinglifecycle.Authority{
			TenantID: tenantID.String(), SpaceID: parse("CHALK_STOP_SPACE_ID").String(),
			EpisodeID: episodeID.String(), RecordingID: recordingID.String(),
		}
		err = pool.QueryRow(ctx, `select authority.job_id::text, authority.attempt_count,
            authority.fencing_generation, authority.capture_epoch, authority.envelope_digest,
            authority.lease_owner, authority.lease_token, authority.lease_expires_at
            from recording_job_attempt_authorities authority
            join recording_jobs job on job.id=authority.job_id
              and job.attempt_count=authority.attempt_count
              and job.fencing_generation=authority.fencing_generation
            where job.tenant_id=$1 and job.recording_id=$2 and job.kind='capture'`,
			tenantID.Bytes(), recordingID.Bytes()).Scan(&authority.JobID, &authority.AttemptCount,
			&authority.FencingGeneration, &authority.CaptureEpoch, &authority.EnvelopeDigest,
			&authority.LeaseOwner, &authority.LeaseToken, &authority.LeaseExpiresAt)
		if err != nil {
			t.Fatal(err)
		}
		if action == "callback" {
			lifecycle, err := recordinglifecycle.NewService(NewRecordingLifecycleRepositoryWithPool(pool), time.Now)
			if err != nil {
				t.Fatal(err)
			}
			publication, err := lifecycle.PublishStopped(ctx, recordinglifecycle.StoppedInput{
				Authority: authority, RequestKey: "late_capture_stopped_" + recordingID.String(), StoppedAt: time.Now().UTC(),
			})
			if err != nil || publication.ExternalOperationID != "" {
				t.Fatalf("late callback acknowledgment = %+v, error = %v", publication, err)
			}
			return
		}
		jobID, err := utilities.ParseID(authority.JobID)
		if err != nil {
			t.Fatal(err)
		}
		for range 2 {
			job, err := service.CompleteCapture(ctx, recordingpipeline.LeaseInput{
				JobID: jobID, AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration,
				CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest,
				LeaseOwner: authority.LeaseOwner, LeaseToken: authority.LeaseToken, LeaseFor: time.Minute,
			})
			if err != nil || job.State != recordingpipeline.JobStateSucceeded {
				t.Fatalf("complete finishing capture = %+v, error = %v", job, err)
			}
		}
	default:
		t.Fatalf("unknown action %q", action)
	}
	if err != nil {
		t.Fatal(err)
	}
}

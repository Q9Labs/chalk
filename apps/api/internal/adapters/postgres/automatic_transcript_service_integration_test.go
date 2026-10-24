package postgres_test

import (
	"context"
	"crypto/sha256"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/aws/recordingkms"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The worker's public service commits real fenced audio allocations. No
// transcript request or MP4 export precedes the automatic transcript jobs.
func TestTranscriptPreparationServiceAutomaticAndOnDemand(t *testing.T) {
	for _, mode := range []string{"automatic", "on_demand"} {
		t.Run(mode, func(t *testing.T) {
			ctx := t.Context()
			tx, fixture := newTranscriptionAllocationCleanupFixture(t, false)
			defer tx.Rollback(context.Background())
			prepareTranscriptionCaptureFacts(t, tx, fixture)
			row, err := sqlc.New(tx).GetRecordingRenderInputByAttempt(ctx, sqlc.GetRecordingRenderInputByAttemptParams{
				RenderJobID: cleanupUUID(fixture.jobID), AttemptCount: 1, FencingGeneration: 1,
			})
			if err != nil {
				t.Fatal(err)
			}
			id := utilities.IDFromBytes
			tenantID := id(row.TenantID.Bytes)
			var expiry time.Time
			if err := tx.QueryRow(ctx, `select lease_expires_at from recording_jobs where id=$1`, fixture.jobID.Bytes()).Scan(&expiry); err != nil {
				t.Fatal(err)
			}
			authority := recordingrender.Authority{
				TenantID: tenantID, SpaceID: id(row.SpaceID.Bytes), EpisodeID: id(row.EpisodeID.Bytes), RecordingID: fixture.recordingID,
				JobID: fixture.jobID, RenderInputHandle: id(row.RenderInputHandle.Bytes), KeyHandle: id(row.KeyHandle.Bytes), ObjectHandle: id(row.ObjectHandle.Bytes),
				AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, EnvelopeDigest: row.EnvelopeDigest,
				LeaseToken: fixture.leaseToken, LeaseOwner: fixture.leaseOwner, LeaseExpiresAt: expiry,
			}
			// Read the Space default for the new Episode; also prove a tenant can opt
			// back into on-demand without changing the automatic ceiling.
			var defaultMode string
			if err := tx.QueryRow(ctx, `select transcription_policy from spaces where id=$1`, authority.SpaceID.Bytes()).Scan(&defaultMode); err != nil || defaultMode != "automatic" {
				t.Fatalf("Space default = %s error=%v", defaultMode, err)
			}
			if mode == "on_demand" {
				execCleanupFixture(t, tx, `update spaces set transcription_policy='on_demand' where id=$1`, authority.SpaceID.Bytes())
			}
			execCleanupFixture(t, tx, `update episodes e set config_snapshot=jsonb_set(e.config_snapshot,'{artifact_policy,transcription,mode}',to_jsonb(s.transcription_policy)) from spaces s where e.space_id=s.id and e.id=$1`, authority.EpisodeID.Bytes())
			execCleanupFixture(t, tx, `update recordings set status='pending',completed_at=null where id=$1`, fixture.recordingID.Bytes())
			execCleanupFixture(t, tx, `delete from recording_transcription_preparation_commits where transcription_job_id=$1`, fixture.jobID.Bytes())
			execCleanupFixture(t, tx, `delete from recording_transcription_sources where recording_id=$1`, fixture.recordingID.Bytes())
			object := func(key string, purpose recordingrender.ObjectPurpose, version int64) recordingrender.CommitObjectReference {
				allocationID, err := utilities.NewID()
				if err != nil {
					t.Fatal(err)
				}
				reservationID, err := utilities.NewID()
				if err != nil {
					t.Fatal(err)
				}
				insertTranscriptionAllocation(t, tx, allocationID, reservationID, version, tenantID, authority.EpisodeID, fixture.recordingID, fixture.jobID, authority.RenderInputHandle, authority.ObjectHandle, fixture.digest, string(purpose), "committed", key)
				checksum := sha256.Sum256([]byte(key))
				reference := recordingrender.CommitObjectReference{AllocationID: allocationID, Purpose: purpose, Object: recordingrender.ObjectFacts{
					ObjectKey: key, ObjectVersion: "version", ObjectETag: "etag", ContentType: "application/json", ByteSize: 1, SHA256: checksum[:],
				}}
				if purpose == recordingrender.PurposeTranscriptionAudio {
					duration := int64(1000)
					reference.DurationMillis = &duration
					reference.Object.ContentType = "audio/flac"
				}
				return reference
			}
			manifest := object("fixtures/"+fixture.recordingID.String()+"/automatic.json", recordingrender.PurposeTranscriptionManifest, 4)
			audio := object("fixtures/"+fixture.recordingID.String()+"/automatic.flac", recordingrender.PurposeTranscriptionAudio, 5)
			chunkID, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			input := recordingrender.TranscriptionPreparationInput{
				Authority: authority, PresentationSHA256: fixture.digest, DurationMillis: 1000,
				TranscriptionSource: &recordingrender.TranscriptionSource{
					SchemaVersion: recordingrender.TranscriptionSourceSchemaVersion, PresentationSHA256: fixture.digest, Manifest: manifest,
					Chunks: []recordingrender.TranscriptionChunk{{ChunkID: chunkID, Generation: 1, EndMillis: 1000, SourceEndMillis: 1000, ParticipantRef: "speaker", ParticipantGeneration: 1, DisplayNameSnapshot: "Speaker", TrackID: "microphone", TrackEpoch: "1", IdentityKind: "participant", TrackClass: "microphone", Object: audio}},
				},
			}
			input.CommitDigest, err = recordingrender.TranscriptionPreparationDigest(input)
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			url := os.Getenv(config.DatabaseURL)
			if url == "" {
				url = config.DefaultDatabaseURL
			}
			pool, err := pgxpool.New(ctx, url)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			defer cleanupAutomaticTranscriptServiceFixture(t, pool, tenantID)
			// KMS and object storage are real adapters, unused by a commit of objects
			// already authenticated and persisted by the upload boundary.
			service, err := recordingrender.NewService(objectstorage.Service{}, recordingkms.Store{}, postgres.NewRecordingRenderRepositoryWithPool(pool, true), recordingrender.Config{KeyID: "unused-by-commit"})
			if err != nil {
				t.Fatal(err)
			}
			result, err := service.CommitTranscriptionPreparation(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			if result == nil || result.SourceID != fixture.recordingID {
				t.Fatalf("source commit = %+v", result)
			}
			assertCounts := func(want int) {
				t.Helper()
				var transcriptCount, jobCount, exportCount int
				err := pool.QueryRow(ctx, `select (select count(*) from transcriptions where recording_id=$1),(select count(*) from artifact_jobs where recording_id=$1 and state='pending'),(select count(*) from recording_jobs where recording_id=$1 and kind='render')`, fixture.recordingID.Bytes()).Scan(&transcriptCount, &jobCount, &exportCount)
				if err != nil || transcriptCount != want || jobCount != want || exportCount != 0 {
					t.Fatalf("transcripts=%d jobs=%d MP4=%d want=%d error=%v", transcriptCount, jobCount, exportCount, want, err)
				}
			}
			if mode == "automatic" {
				if len(result.JobIDs) != 1 {
					t.Fatalf("automatic jobs = %v", result.JobIDs)
				}
				assertCounts(1)
			} else {
				assertCounts(0)
				repository := postgres.NewTranscriptRepositoryWithPool(sqlc.New(pool), pool)
				transcript, job, err := transcripts.NewService(repository).Request(ctx, transcripts.RequestInput{TenantID: tenantID, RecordingID: fixture.recordingID, IdempotencyKey: "on-demand-after-automatic-default", AttemptLimit: 4, Now: time.Now()})
				if err != nil || transcript.ID.IsZero() || job.ID.IsZero() {
					t.Fatalf("on-demand request: %+v %+v %v", transcript, job, err)
				}
				assertCounts(1)
			}
			replay, err := service.CommitTranscriptionPreparation(ctx, input)
			if err != nil || replay == nil || replay.SourceID != result.SourceID {
				t.Fatalf("commit replay: %+v %v", replay, err)
			}
			assertCounts(1)
		})
	}
}

func cleanupAutomaticTranscriptServiceFixture(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Error(err)
		return
	}
	defer tx.Rollback(ctx)
	// These test facts include immutable capture authority and cyclic source
	// leases. Disable triggers only in this cleanup transaction, on this gate DB.
	tables := []string{"recording_transcription_preparation_commits", "artifact_jobs", "transcript_chunks", "recording_transcription_source_chunks", "recording_transcription_sources", "transcriptions", "recording_render_object_allocations", "recording_render_inputs", "recording_data_keys", "recording_presentations", "recording_presentation_sources", "recording_presentation_baselines", "recording_job_attempt_authorities", "recording_jobs", "recording_pipelines", "recording_reservations", "recordings", "episodes", "spaces", "tenant_artifact_policies", "tenants"}
	for _, table := range tables {
		if _, err := tx.Exec(ctx, "alter table "+table+" disable trigger all"); err != nil {
			t.Error(err)
			return
		}
	}
	for _, table := range tables {
		predicate := "tenant_id=$1"
		if table == "tenants" {
			predicate = "id=$1"
		}
		if table == "recording_job_attempt_authorities" {
			predicate = "job_id in (select id from recording_jobs where tenant_id=$1)"
		}
		if _, err := tx.Exec(ctx, "delete from "+table+" where "+predicate, tenantID.Bytes()); err != nil {
			t.Error(err)
			return
		}
		if _, err := tx.Exec(ctx, "alter table "+table+" enable trigger all"); err != nil {
			t.Error(err)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Error(err)
	}
}

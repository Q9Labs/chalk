package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type commitArtifactQuerier struct {
	sqlc.Querier
	getArtifact       func(context.Context, sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error)
	commitArtifact    func(context.Context, sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error)
	authorizeArtifact func(context.Context, sqlc.AuthorizeRecordingArtifactReplayParams) (bool, error)
}

func (q commitArtifactQuerier) GetRecordingArtifact(ctx context.Context, params sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error) {
	return q.getArtifact(ctx, params)
}

func (q commitArtifactQuerier) CommitRecordingArtifact(ctx context.Context, params sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error) {
	return q.commitArtifact(ctx, params)
}

func (q commitArtifactQuerier) AuthorizeRecordingArtifactReplay(ctx context.Context, params sqlc.AuthorizeRecordingArtifactReplayParams) (bool, error) {
	if q.authorizeArtifact == nil {
		return true, nil
	}
	return q.authorizeArtifact(ctx, params)
}

func TestCommitArtifactAmbiguousRetryReturnsExactArtifact(t *testing.T) {
	input := artifactInputForTest(t)
	existing := artifactRecordForTest(input)
	commitCalled := false
	repository := NewRecordingPipelineRepository(commitArtifactQuerier{
		getArtifact: func(context.Context, sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error) {
			if commitCalled {
				return existing, nil
			}
			return sqlc.RecordingArtifact{}, pgx.ErrNoRows
		},
		commitArtifact: func(context.Context, sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error) {
			commitCalled = true
			return sqlc.CommitRecordingArtifactRow{}, pgx.ErrNoRows
		},
	})

	artifact, err := repository.CommitArtifact(context.Background(), input)
	if err != nil {
		t.Fatalf("commit artifact replay: %v", err)
	}
	if artifact.RecordingID != input.RecordingID || artifact.RenderJobID != input.RenderJobID || artifact.ObjectKey != input.ObjectKey {
		t.Fatalf("replayed artifact = %+v", artifact)
	}
}

func TestCommitArtifactReplayRejectsWrongAttemptAuthority(t *testing.T) {
	input := artifactInputForTest(t)
	repository := NewRecordingPipelineRepository(commitArtifactQuerier{
		getArtifact: func(context.Context, sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error) {
			return artifactRecordForTest(input), nil
		},
		authorizeArtifact: func(context.Context, sqlc.AuthorizeRecordingArtifactReplayParams) (bool, error) {
			return false, pgx.ErrNoRows
		},
	})

	_, err := repository.CommitArtifact(context.Background(), input)
	if !errors.Is(err, recordingpipeline.ErrJobNotFound) {
		t.Fatalf("unauthorized artifact replay error = %v, want %v", err, recordingpipeline.ErrJobNotFound)
	}
}

func TestCommitArtifactAmbiguousRetryRejectsConflictingArtifact(t *testing.T) {
	input := artifactInputForTest(t)
	existing := artifactRecordForTest(input)
	existing.ByteSize++
	commitCalled := false
	repository := NewRecordingPipelineRepository(commitArtifactQuerier{
		getArtifact: func(context.Context, sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error) {
			if commitCalled {
				return existing, nil
			}
			return sqlc.RecordingArtifact{}, pgx.ErrNoRows
		},
		commitArtifact: func(context.Context, sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error) {
			commitCalled = true
			return sqlc.CommitRecordingArtifactRow{}, pgx.ErrNoRows
		},
	})

	_, err := repository.CommitArtifact(context.Background(), input)
	if !errors.Is(err, recordingpipeline.ErrArtifactConflict) {
		t.Fatalf("conflicting artifact error = %v, want %v", err, recordingpipeline.ErrArtifactConflict)
	}
}

func artifactInputForTest(t *testing.T) recordingpipeline.ArtifactInput {
	t.Helper()
	tenantID := mustIDForTest(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be101")
	recordingID := mustIDForTest(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be102")
	renderJobID := mustIDForTest(t, "6a9b6a12-7457-4fe9-a58b-8b234d0be103")
	return recordingpipeline.ArtifactInput{
		TenantID: tenantID, RecordingID: recordingID, RenderJobID: renderJobID,
		ObjectKey: "recordings/final.mp4", ContentType: "video/mp4", ByteSize: 64,
		Checksum: []byte("0123456789abcdef"), Duration: time.Second,
		AttemptCount: 1, FencingGeneration: 1, LeaseToken: "lease", LeaseOwner: "owner",
		CaptureEpoch: 1, EnvelopeDigest: make([]byte, 32),
	}
}

func artifactRecordForTest(input recordingpipeline.ArtifactInput) sqlc.RecordingArtifact {
	return sqlc.RecordingArtifact{
		RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID), RenderJobID: uuid(input.RenderJobID),
		ObjectKey: input.ObjectKey, ContentType: input.ContentType, ByteSize: input.ByteSize,
		Checksum: input.Checksum, DurationMillis: input.Duration.Milliseconds(),
	}
}

func mustIDForTest(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

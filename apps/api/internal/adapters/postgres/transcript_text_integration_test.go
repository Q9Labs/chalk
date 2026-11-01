package postgres_test

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTranscriptTextMetadataBeforeMP4Export(t *testing.T) {
	ctx := t.Context()
	tx, fixture := newTranscriptionAllocationCleanupFixture(t, false)
	defer func() { _ = tx.Rollback(ctx) }()
	transcriptID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	var tenantID pgtype.UUID
	if err := tx.QueryRow(ctx, `insert into transcriptions (id, tenant_id, recording_id, space_id, episode_id, status, languages)
		select $1, tenant_id, id, space_id, episode_id, 'complete', array['en']::text[]
		from recordings where id = $2 returning tenant_id`, transcriptID.Bytes(), fixture.recordingID.Bytes()).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	// No MP4 duration exists, and allocation predates actual capture readiness.
	execCleanupFixture(t, tx, `update recordings set duration_millis = null, created_at = now() - interval '1 day' where id = $1`, fixture.recordingID.Bytes())
	queries := sqlc.New(tx)
	metadata, err := queries.GetTranscriptTextMetadata(ctx, sqlc.GetTranscriptTextMetadataParams{TenantID: tenantID, TranscriptID: cleanupUUID(transcriptID)})
	if err != nil {
		t.Fatal(err)
	}
	var captureReadyAt time.Time
	if err := tx.QueryRow(ctx, `select capture_ready_at from recording_presentation_sources where recording_id = $1`, fixture.recordingID.Bytes()).Scan(&captureReadyAt); err != nil {
		t.Fatal(err)
	}
	if metadata.SpaceTitle != "transcription allocation cleanup" || metadata.DurationMillis != 1000 || !metadata.StartedAt.Time.Equal(captureReadyAt) {
		t.Fatalf("metadata before MP4 export = %#v, capture ready at %s", metadata, captureReadyAt)
	}
	_, err = queries.GetTranscriptTextMetadata(ctx, sqlc.GetTranscriptTextMetadataParams{TenantID: cleanupUUID(transcriptID), TranscriptID: cleanupUUID(transcriptID)})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("foreign Tenant metadata error = %v", err)
	}
}

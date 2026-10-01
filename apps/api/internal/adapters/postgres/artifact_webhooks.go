package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

// Artifact webhook snapshots contain public identities, never storage keys or signed URLs.
func produceRecordingWebhook(ctx context.Context, tx pgx.Tx, tenantID, recordingID utilities.ID, status string, occurredAt time.Time, failureCode string) (webhookCommitMetric, error) {
	row, err := sqlc.New(tx).GetTenantRecording(ctx, sqlc.GetTenantRecordingParams{TenantID: uuid(tenantID), ID: uuid(recordingID)})
	if err != nil {
		return webhookCommitMetric{}, fmt.Errorf("load Recording webhook snapshot: %w", err)
	}
	startedAt := timestamp(row.CreatedAt)
	var captureReadyAt *time.Time
	if err := tx.QueryRow(ctx, `select capture_ready_at from recording_pipelines where tenant_id=$1 and recording_id=$2`, uuid(tenantID), uuid(recordingID)).Scan(&captureReadyAt); err != nil {
		return webhookCommitMetric{}, fmt.Errorf("load Recording webhook origin: %w", err)
	}
	if captureReadyAt != nil {
		startedAt = *captureReadyAt
	}
	snapshot := webhooks.RecordingSnapshot{ID: recordingID.String(), SpaceID: id(row.SpaceID).String(), EpisodeID: id(row.EpisodeID).String(), Status: status, StartedAt: &startedAt, CreatedAt: timestamp(row.CreatedAt), UpdatedAt: occurredAt}
	switch status {
	case "completed":
		snapshot.CompletedAt = &occurredAt
	case "failed":
		snapshot.FailedAt = &occurredAt
		snapshot.Failure = &webhooks.ArtifactFailure{Code: publicArtifactFailureCode(failureCode)}
	}
	return fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: "recording." + status, SemanticKey: "recording:" + recordingID.String() + ":" + status, ResourceType: "recording", ResourceID: recordingID, OccurredAt: occurredAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return webhooks.EncodeRecordingEvent(metadata, snapshot)
	}})
}

func produceFailedTranscriptJobWebhook(ctx context.Context, tx pgx.Tx, job sqlc.ArtifactJob) (webhookCommitMetric, error) {
	var err error
	job, err = sqlc.New(tx).GetArtifactJob(ctx, job.ID)
	if err != nil {
		return webhookCommitMetric{}, fmt.Errorf("load failed Transcript job: %w", err)
	}
	if job.State != "dead_letter" || !job.TranscriptID.Valid {
		return webhookCommitMetric{}, nil
	}
	row, err := sqlc.New(tx).GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: job.TenantID, ID: job.TranscriptID})
	if err != nil {
		return webhookCommitMetric{}, fmt.Errorf("load failed Transcript webhook snapshot: %w", err)
	}
	if row.Status != transcripts.StatusTerminalFailure {
		return webhookCommitMetric{}, nil
	}
	return produceTranscriptWebhook(ctx, tx, row, "failed", timestamp(row.UpdatedAt), job.ErrorCode.String)
}

// Recovery precedes claims too: expired terminal jobs must publish even when there is no next job to lease.
func recoverTranscriptJobsTx(ctx context.Context, tx pgx.Tx, now, availableAt time.Time) ([]sqlc.ArtifactJob, error) {
	rows, err := sqlc.New(tx).RecoverExpiredArtifactJobs(ctx, sqlc.RecoverExpiredArtifactJobsParams{Now: pgtype.Timestamptz{Time: now, Valid: true}, AvailableAt: pgtype.Timestamptz{Time: availableAt, Valid: true}})
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// Finish all claim mutations before taking webhook Tenant locks. Otherwise a
// concurrent claim can hold a Transcript row while waiting for our Tenant lock.
func commitRecoveredTranscriptJobsTx(ctx context.Context, tx pgx.Tx, rows []sqlc.ArtifactJob) error {
	metrics := make([]webhookCommitMetric, 0, len(rows))
	for _, row := range rows {
		metric, err := produceFailedTranscriptJobWebhook(ctx, tx, row)
		if err != nil {
			return err
		}
		metrics = append(metrics, metric)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, metric := range metrics {
		metric.Record(ctx)
	}
	return nil
}

func produceTranscriptWebhook(ctx context.Context, tx pgx.Tx, row sqlc.Transcription, status string, occurredAt time.Time, failureCode string) (webhookCommitMetric, error) {
	transcriptID := id(row.ID)
	startedAt := timestamp(row.CreatedAt)
	snapshot := webhooks.TranscriptSnapshot{ID: transcriptID.String(), RecordingID: id(row.RecordingID).String(), SpaceID: id(row.SpaceID).String(), EpisodeID: id(row.EpisodeID).String(), Status: status, Languages: row.Languages, StartedAt: &startedAt, CreatedAt: startedAt, UpdatedAt: occurredAt}
	switch status {
	case "completed":
		snapshot.CompletedAt = &occurredAt
	case "failed":
		snapshot.FailedAt = &occurredAt
		snapshot.Failure = &webhooks.ArtifactFailure{Code: publicArtifactFailureCode(failureCode)}
	}
	return fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: id(row.TenantID), EventName: "transcript." + status, SemanticKey: fmt.Sprintf("transcript:%s:%d:%s", transcriptID.String(), row.Generation, status), ResourceType: "transcript", ResourceID: transcriptID, OccurredAt: occurredAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return webhooks.EncodeTranscriptEvent(metadata, snapshot)
	}})
}

// The public code is bounded independently of worker error details; an oversized
// worker code must not prevent committing its terminal state.
func publicArtifactFailureCode(code string) string {
	if len(code) == 0 || len(code) > 96 {
		return "worker_failed"
	}
	return code
}

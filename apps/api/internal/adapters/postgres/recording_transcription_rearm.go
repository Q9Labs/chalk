package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

func (r RecordingPipelineRepository) GetTranscriptionRearmCandidate(ctx context.Context, recordingID utilities.ID) (recordingpipeline.TranscriptionRearmCandidate, error) {
	row, err := r.queries.GetRecordingTranscriptionRearmCandidate(ctx, uuid(recordingID))
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.TranscriptionRearmCandidate{}, recordingpipeline.ErrJobNotFound
	}
	if err != nil {
		return recordingpipeline.TranscriptionRearmCandidate{}, fmt.Errorf("get transcription re-arm candidate: %w", err)
	}
	return mapGetTranscriptionRearmCandidate(row), nil
}

func (r RecordingPipelineRepository) ListTranscriptionRearmCandidates(ctx context.Context, after *utilities.ID, batchSize int) ([]recordingpipeline.TranscriptionRearmCandidate, error) {
	cursor := pgtype.UUID{}
	if after != nil {
		cursor = uuid(*after)
	}
	rows, err := r.queries.ListRecordingTranscriptionRearmCandidates(ctx, sqlc.ListRecordingTranscriptionRearmCandidatesParams{
		AfterRecordingID: cursor, BatchSize: int32(batchSize),
	})
	if err != nil {
		return nil, fmt.Errorf("list transcription re-arm candidates: %w", err)
	}
	candidates := make([]recordingpipeline.TranscriptionRearmCandidate, 0, len(rows))
	for _, row := range rows {
		candidates = append(candidates, mapListTranscriptionRearmCandidate(row))
	}
	return candidates, nil
}

// RearmTranscription grants an expired, never-claimed transcription job one
// fresh source window. The renewal is append-only; the job update replays no
// worker authority because the fencing generation moves first.
func (r RecordingPipelineRepository) RearmTranscription(ctx context.Context, input recordingpipeline.TranscriptionRearmInput) (recordingpipeline.TranscriptionRearmResult, error) {
	ctx, span := otel.Tracer("chalk/recordingpipeline").Start(ctx, "recording.transcription.rearm")
	defer span.End()
	outcome, reason := "rejected", "not_eligible"
	defer func() {
		span.SetAttributes(attribute.String("outcome", outcome), attribute.String("reason", reason))
		slog.InfoContext(ctx, "Recording transcription re-arm", "event", "recording.transcription.rearm", "outcome", outcome, "reason", reason, "recording_id", input.RecordingID.String())
	}()
	if err := recordingpipeline.ValidateTranscriptionRearmInput(input); err != nil {
		return recordingpipeline.TranscriptionRearmResult{}, err
	}
	var result recordingpipeline.TranscriptionRearmResult
	err := r.transaction(ctx, func(tx pgx.Tx, _ recordingPipelineQuerier) error {
		queries := sqlc.New(tx)
		if _, err := queries.LockRecordingTranscriptionRearmPipeline(ctx, uuid(input.RecordingID)); err != nil {
			return err
		}
		row, err := queries.LockRecordingTranscriptionRearmJob(ctx, uuid(input.RecordingID))
		if err != nil {
			return err
		}
		candidate := mapLockedTranscriptionRearmCandidate(row)
		if candidate.HasRenewal && (candidate.State != recordingpipeline.JobStateTerminalFailure || candidate.ErrorCode != "recording_source_expired") {
			reason = "already_rearmed"
			return recordingpipeline.ErrTranscriptionRearmNotNeeded
		}
		if refusal := recordingpipeline.TranscriptionRearmRefusal(candidate, r.now().UTC()); refusal != "" {
			reason = refusal
			return recordingpipeline.ErrTranscriptionRearmUnavailable
		}
		generation := candidate.FencingGeneration + 1
		renewal, err := queries.InsertRecordingTranscriptionSourceRenewal(ctx, sqlc.InsertRecordingTranscriptionSourceRenewalParams{
			FencingGeneration: generation, Operator: input.Operator, Reason: input.Reason,
			JobID: uuid(candidate.JobID), RecordingID: uuid(input.RecordingID),
		})
		if err != nil {
			return err
		}
		if _, err := queries.ArchiveRecordingTranscriptionRearmFailure(ctx, sqlc.ArchiveRecordingTranscriptionRearmFailureParams{
			ManualRetryCount: int32(candidate.FailureHistoryCount + 1), JobID: uuid(candidate.JobID),
		}); err != nil {
			return err
		}
		if _, err := queries.RearmRecordingTranscriptionJob(ctx, sqlc.RearmRecordingTranscriptionJobParams{
			FencingGeneration: generation, JobID: uuid(candidate.JobID), RecordingID: uuid(input.RecordingID),
		}); err != nil {
			return err
		}
		result = recordingpipeline.TranscriptionRearmResult{
			JobID: candidate.JobID, FencingGeneration: generation, SourceExpiresAt: renewal.SourceExpiresAt.Time.UTC(),
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpipeline.TranscriptionRearmResult{}, recordingpipeline.ErrTranscriptionRearmUnavailable
	}
	if errors.Is(err, recordingpipeline.ErrTranscriptionRearmNotNeeded) {
		outcome = "unchanged"
		return recordingpipeline.TranscriptionRearmResult{}, err
	}
	if err != nil {
		return recordingpipeline.TranscriptionRearmResult{}, fmt.Errorf("rearm recording transcription: %w", err)
	}
	outcome, reason = "accepted", "queued"
	return result, nil
}

func mapTranscriptionRearmCandidateFields(recordingID, tenantID, episodeID, jobID utilities.ID, state string, errorCode string, attemptCount int32, fencingGeneration int64, retention *time.Time, captureSucceeded bool, mode string, hasSource, hasTranscript, hasKey, hasPresentation bool, bundleCount int32, cleanupStarted, hasAuthority bool, historyCount int32, hasRenewal bool) recordingpipeline.TranscriptionRearmCandidate {
	return recordingpipeline.TranscriptionRearmCandidate{
		RecordingID: recordingID, TenantID: tenantID, EpisodeID: episodeID, JobID: jobID,
		State: recordingpipeline.JobState(state), ErrorCode: errorCode, AttemptCount: int(attemptCount), FencingGeneration: fencingGeneration,
		CaptureRetentionExpiresAt: retention, CaptureSucceeded: captureSucceeded, TranscriptionMode: mode,
		HasTranscriptionSource: hasSource, HasTranscript: hasTranscript, HasDataKey: hasKey, HasPresentation: hasPresentation,
		BundleCount: int(bundleCount), CleanupStarted: cleanupStarted, HasAttemptAuthority: hasAuthority,
		FailureHistoryCount: int(historyCount), HasRenewal: hasRenewal,
	}
}

func mapGetTranscriptionRearmCandidate(row sqlc.GetRecordingTranscriptionRearmCandidateRow) recordingpipeline.TranscriptionRearmCandidate {
	candidate := mapTranscriptionRearmCandidateFields(
		utilities.IDFromBytes(row.RecordingID.Bytes), utilities.IDFromBytes(row.TenantID.Bytes), utilities.IDFromBytes(row.EpisodeID.Bytes), utilities.IDFromBytes(row.JobID.Bytes),
		row.State, row.ErrorCode.String, row.AttemptCount, row.FencingGeneration, nullableTimestamp(row.CaptureRetentionExpiresAt), row.CaptureSucceeded, row.TranscriptionMode,
		row.HasTranscriptionSource, row.HasTranscript, row.HasDataKey, row.HasPresentation, row.BundleCount, row.CleanupStarted, row.HasAttemptAuthority, row.FailureHistoryCount, row.HasRenewal,
	)
	candidate.ObjectKeys = append([]string(nil), row.ObjectKeys...)
	return candidate
}

func mapListTranscriptionRearmCandidate(row sqlc.ListRecordingTranscriptionRearmCandidatesRow) recordingpipeline.TranscriptionRearmCandidate {
	candidate := mapTranscriptionRearmCandidateFields(
		utilities.IDFromBytes(row.RecordingID.Bytes), utilities.IDFromBytes(row.TenantID.Bytes), utilities.IDFromBytes(row.EpisodeID.Bytes), utilities.IDFromBytes(row.JobID.Bytes),
		row.State, row.ErrorCode.String, row.AttemptCount, row.FencingGeneration, nullableTimestamp(row.CaptureRetentionExpiresAt), row.CaptureSucceeded, row.TranscriptionMode,
		row.HasTranscriptionSource, row.HasTranscript, row.HasDataKey, row.HasPresentation, row.BundleCount, row.CleanupStarted, row.HasAttemptAuthority, row.FailureHistoryCount, row.HasRenewal,
	)
	candidate.ObjectKeys = append([]string(nil), row.ObjectKeys...)
	return candidate
}

func mapLockedTranscriptionRearmCandidate(row sqlc.LockRecordingTranscriptionRearmJobRow) recordingpipeline.TranscriptionRearmCandidate {
	return mapTranscriptionRearmCandidateFields(
		utilities.IDFromBytes(row.RecordingID.Bytes), utilities.IDFromBytes(row.TenantID.Bytes), utilities.IDFromBytes(row.EpisodeID.Bytes), utilities.IDFromBytes(row.ID.Bytes),
		row.State, row.ErrorCode.String, row.AttemptCount, row.FencingGeneration, nullableTimestamp(row.CaptureRetentionExpiresAt), row.CaptureSucceeded, row.TranscriptionMode,
		row.HasTranscriptionSource, row.HasTranscript, row.HasDataKey, row.HasPresentation, row.BundleCount, row.CleanupStarted, row.HasAttemptAuthority, row.FailureHistoryCount, row.HasRenewal,
	)
}

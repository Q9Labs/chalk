package postgres

import (
	"context"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

// These events describe committed repository results, not worker reports or
// successful media recovery. Never include a job's free-text error or payload.
func logRecoveredRecordingJob(ctx context.Context, job recordingpipeline.Job) {
	reason := "other"
	if job.ErrorCode != nil {
		switch *job.ErrorCode {
		case "recording_source_expired", "render_deadline_exceeded", "capture_completion_expired",
			"capture_stopped_before_completion", "lease_expired":
			reason = *job.ErrorCode
		}
	}
	attrs := []any{
		"event", "recording.job_recovered",
		"tenant_id", job.TenantID.String(), "episode_id", job.EpisodeID.String(),
		"recording_id", job.RecordingID.String(), "job_id", job.ID.String(),
		"kind", job.Kind, "state", job.State, "reason", reason,
		"attempt_count", job.AttemptCount, "attempt_limit", job.AttemptLimit,
		"fencing_generation", job.FencingGeneration, "transition_at", job.UpdatedAt,
	}
	// SQL supplies this exact marker only for a stopped, never-claimed capture.
	// All other details, including otherwise valid worker diagnostics, stay private.
	if reason == "capture_stopped_before_completion" && job.AttemptCount == 0 && job.ErrorDetail != nil &&
		*job.ErrorDetail == "stage=capture_start outcome=stopped_before_claim error_class=none" {
		attrs = append(attrs, "capture_outcome", "stopped_before_claim")
	}
	slog.InfoContext(ctx, "recording job recovery committed", attrs...)
}

func logExpiredRecordingReservation(ctx context.Context, reservation recordingpipeline.Reservation) {
	slog.InfoContext(ctx, "recording reservation expiry committed",
		"event", "recording.reservation_expired",
		"tenant_id", reservation.TenantID.String(), "space_id", reservation.SpaceID.String(),
		"episode_id", reservation.EpisodeID.String(), "recording_id", reservation.RecordingID.String(),
		"reservation_id", reservation.ID.String(), "state", reservation.State,
		"reason", "capture_reservation_expired", "transition_at", reservation.UpdatedAt)
}

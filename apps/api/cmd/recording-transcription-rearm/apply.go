package main

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func applyCandidate(ctx context.Context, resources commandResources, options commandOptions, candidate recordingpipeline.TranscriptionRearmCandidate, outcome recordingOutcome) (recordingOutcome, error) {
	rearmCtx, rearmSpan := resources.tracer.Start(ctx, "recording.transcription.rearm.apply", trace.WithAttributes(
		attribute.String("recording.id", candidate.RecordingID.String()), attribute.String("recording.job.id", candidate.JobID.String()),
	))
	rearmed, err := resources.repository.RearmTranscription(rearmCtx, recordingpipeline.TranscriptionRearmInput{
		RecordingID: candidate.RecordingID, Operator: options.operator, Reason: options.reason,
	})
	rearmSpan.End()
	if errors.Is(err, recordingpipeline.ErrTranscriptionRearmNotNeeded) {
		outcome.Outcome = "already_rearmed"
		return outcome, nil
	}
	if errors.Is(err, recordingpipeline.ErrTranscriptionRearmUnavailable) {
		outcome.Outcome = "no_longer_eligible"
		return outcome, nil
	}
	if err != nil {
		return outcome, databaseFailure("apply transcription re-arm; rerunning is idempotent", err)
	}
	outcome.Outcome = "rearmed"
	outcome.SourceExpiresAt = rearmed.SourceExpiresAt.Format(time.RFC3339)
	return outcome, nil
}

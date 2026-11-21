package recorderworker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func (attempt *ProductionRenderAttempt) measure(ctx context.Context, stage RenderAttemptStage, action func() error) error {
	started := time.Now()
	err := obs.Op(ctx, obs.EventRecordingRenderStage, func(opCtx context.Context, scope *obs.Scope) error {
		return action()
	}, slog.String(obs.FieldJobID, attempt.claim.Envelope.JobID), slog.String(obs.FieldRecordingStage, string(stage)))
	observability.LogRenderStage(ctx, string(stage), err == nil, time.Since(started))
	if err != nil {
		return renderStageError{stage: stage, err: err}
	}
	return nil
}

// renderStageError names the stage a render failed in. Its text is the cause's text, so the
// bounded diagnostics built from it do not change.
type renderStageError struct {
	stage RenderAttemptStage
	err   error
}

func (e renderStageError) Error() string { return e.err.Error() }
func (e renderStageError) Unwrap() error { return e.err }

// renderFailureCode reports the stage that failed, such as render_download_capture_failed.
func renderFailureCode(cause error) string {
	var stageErr renderStageError
	if errors.As(cause, &stageErr) {
		return recordingpipeline.SanitizeRenderFailureCode("render_" + string(stageErr.stage) + "_failed")
	}
	return recordingpipeline.DefaultRenderFailureCode
}

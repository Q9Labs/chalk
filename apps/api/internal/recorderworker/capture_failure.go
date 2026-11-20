package recorderworker

import (
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

// captureStageError names the failed close step. The stage is a known literal,
// so failure sanitizing keeps it even when the cause is redacted.
func captureStageError(stage string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", stage, err)
}

func captureFailureInput(lease recordingpipeline.LeaseInput, availableAt time.Time, cause error) recordingpipeline.FailureInput {
	code, detail := recordingpipeline.SanitizeCaptureFailure(defaultCaptureFailureCode, cause.Error())
	return recordingpipeline.FailureInput{LeaseInput: lease, AvailableAt: availableAt, ErrorCode: code, ErrorDetail: detail}
}

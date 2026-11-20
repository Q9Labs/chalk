package recorderworker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

type captureFailedCloseCoordinator struct {
	captureTestCoordinator
	failure error
}

func (coordinator *captureFailedCloseCoordinator) Close(context.Context, bool) error {
	return coordinator.failure
}

func TestCaptureFailureKeepsCloseStageWhenJoinedCauseIsRedacted(t *testing.T) {
	attempt := captureStoppedTestAttempt(t, time.Unix(1000, 0).UTC(), &captureTestLifecycle{}, time.Second)
	secret := "opaque-credential"
	attempt.coordinator = &captureFailedCloseCoordinator{failure: TransportError{Err: errors.New(secret)}}
	err := attempt.finishFailure(errors.New("https://storage.invalid/bundle?token="+strings.Repeat(secret, 64)), nil)
	_, detail := recordingpipeline.SanitizeCaptureFailure(defaultCaptureFailureCode, err.Error())
	if !strings.Contains(detail, "close capture connection: recorder control-plane transport failed") || strings.Contains(detail, secret) || strings.Contains(detail, "https://") {
		t.Fatalf("want a safe close diagnostic without credentials, got %q", detail)
	}
}

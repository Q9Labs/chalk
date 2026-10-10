package recorderworker

import (
	"context"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestInvalidCompletionSourceReportsDurableFailureWithoutSpinning(t *testing.T) {
	err := withAPIErrorCode(classifyHTTPError(http.StatusUnprocessableEntity), []byte(`{"error":{"code":"recording.invalid_completion_source"}}`))
	control := &captureControlStub{complete: func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		return recordingpipeline.Job{}, err
	}}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return nil }}, nil
	}), nil)
	claim := captureDaemonClaim(t, 7)
	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatal(err)
	}
	want := "stage=api_complete outcome=returned error_class=http http_status=422 api_error_code=recording.invalid_completion_source"
	if control.completeCalls != 1 || control.failCalls != 1 || control.failed.ErrorCode != completionFailureCode || control.failed.ErrorDetail != want || control.failed.CaptureEpoch != claim.Envelope.CaptureEpoch {
		t.Fatalf("completion calls/failures/failure = %d/%d/%+v", control.completeCalls, control.failCalls, control.failed)
	}
}

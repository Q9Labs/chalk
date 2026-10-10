package httpapi

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestRecorderCompletionLogsNonPresentationFailure(t *testing.T) {
	var logs bytes.Buffer
	handler := NewRecorderWorkerRouterWithControls(recorderWorkerServiceStub{
		completeCapture: func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
			return recordingpipeline.Job{}, errors.New("commit capture transaction: regression cause")
		},
	}, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: mustRecorderWorkerID(t, workerTestID), Role: workeridentity.RoleCapture}}, RecorderWorkerControlServices{
		Logger: slog.New(slog.NewJSONHandler(&logs, nil)),
	})
	body := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","lease_for_seconds":60,"capture_epoch":1,"envelope_digest":"` + workerTestDigest + `"}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/complete", body))
	if response.Code != http.StatusInternalServerError || !strings.Contains(logs.String(), "regression cause") || strings.Contains(response.Body.String(), "regression cause") {
		t.Fatalf("completion status/log/body = %d/%s/%s", response.Code, logs.String(), response.Body.String())
	}
}

func TestRecorderStoppedLogsFailureCause(t *testing.T) {
	var logs bytes.Buffer
	service := recorderRecordingLifecycleServiceStub{stopped: func(context.Context, recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error) {
		return recordinglifecycle.Publication{}, errors.New("publish stopped transaction: regression cause")
	}}
	handler := observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)))(recorderRecordingLifecycleRouter(t, workeridentity.RoleCapture, service))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/stopped", recordingLifecycleAuthorityJSON()+`,"request_key":"capture_stopped_44444444-4444-4444-8444-444444444444_3","observed_at":"2026-08-25T12:01:00Z"}`))
	if response.Code != http.StatusInternalServerError || !strings.Contains(logs.String(), "regression cause") || strings.Contains(response.Body.String(), "regression cause") {
		t.Fatalf("stopped status/log/body = %d/%s/%s", response.Code, logs.String(), response.Body.String())
	}
}

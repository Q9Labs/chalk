package httpapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type failRecordingService struct {
	RecorderWorkerService
	got recordingpipeline.FailureInput
}

func (s *failRecordingService) Fail(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	s.got = input
	return recordingpipeline.Job{Kind: recordingpipeline.JobKindCapture, State: recordingpipeline.JobStatePending}, nil
}

// Both sinks take their value from the input the handler gives the service: the service
// stores it and the handler logs it. Secret text in the worker's ErrorDetail must reach neither.
func TestCaptureFailureDetailIsSanitizedBeforeStorageAndLog(t *testing.T) {
	const token = "lease-token-AbCdEf0123456789"
	const signedURL = "https://objects.example.test/bundles/seg-1.mp4?X-Amz-Signature=deadbeef0123"
	const caption = "Dr Synthetic Person says the quarterly numbers are private"
	jobID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	workerID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(recorderWorkerFailBody{
		recorderWorkerLeaseBody: recorderWorkerLeaseBody{
			JobID: jobID.String(), AttemptCount: 1, FencingGeneration: 1, LeaseToken: token, CaptureEpoch: 1,
			EnvelopeDigest: hex.EncodeToString(bytes.Repeat([]byte{7}, 32)),
		},
		ErrorCode:   "capture_attempt_failed",
		ErrorDetail: "capture MID 0: read " + signedURL + ": " + token + ": " + caption + ": EOF",
	})
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	service := &failRecordingService{}
	request := httptest.NewRequest(http.MethodPost, "/recorder/jobs/fail", bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), recorderWorkerIdentityContextKey{},
		workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}))
	response := httptest.NewRecorder()
	recorderWorkerFailHandler(service, slog.New(slog.NewJSONHandler(&logs, nil)))(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	const want = "capture MID 0: [redacted]: EOF"
	if service.got.ErrorDetail != want {
		t.Fatalf("service must get the sanitized detail:\n got %q\nwant %q", service.got.ErrorDetail, want)
	}
	for sink, text := range map[string]string{"stored detail": service.got.ErrorDetail, "log line": logs.String()} {
		for _, secret := range []string{token, "X-Amz", "objects.example.test", "deadbeef", "Synthetic", "quarterly"} {
			if strings.Contains(text, secret) {
				t.Fatalf("%s kept %q: %s", sink, secret, text)
			}
		}
	}
	if !strings.Contains(logs.String(), `"error_detail":"capture MID 0: [redacted]: EOF"`) {
		t.Fatalf("log line lost the safe diagnostic: %s", logs.String())
	}
}

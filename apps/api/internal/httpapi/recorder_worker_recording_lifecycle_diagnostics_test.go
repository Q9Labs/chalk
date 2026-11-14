package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type stoppedCallbackService struct {
	RecorderRecordingLifecycleService
	err error
}

func (s stoppedCallbackService) PublishStopped(context.Context, recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error) {
	return recordinglifecycle.Publication{}, s.err
}

func TestCaptureStoppedCallbackAcceptanceIsLoggedWithoutRequestSecrets(t *testing.T) {
	for _, test := range []struct {
		name     string
		err      error
		status   int
		accepted bool
	}{
		{"accepted", nil, http.StatusNoContent, true},
		{"stop pending", recordinglifecycle.ErrEpisodeStopPending, http.StatusServiceUnavailable, false},
		{"stale authority", recordinglifecycle.ErrAuthorityMismatch, http.StatusConflict, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(recorderprotocol.CaptureStoppedRequest{
				CaptureLifecycleAuthority: recorderprotocol.CaptureLifecycleAuthority{
					RecordingAuthority: recorderprotocol.RecordingAuthority{
						TenantID: workerTestTenant, EpisodeID: workerTestEpisode, RecordingID: workerTestRecord, JobID: workerTestJob,
						AttemptCount: 2, FencingGeneration: 3, CaptureEpoch: 1, EnvelopeDigest: strings.Repeat("ab", 32),
						LeaseToken: "private-lease-token", LeaseOwner: recorderWorkerLeaseOwner(workeridentity.Identity{WorkerID: mustRecorderWorkerID(t, workerTestID), Role: workeridentity.RoleCapture}), LeaseExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
					}, SpaceID: workerTestTenant,
				}, RequestKey: "private-request-key", ObservedAt: time.Unix(1000, 0).UTC().Format(time.RFC3339Nano),
			})
			if err != nil {
				t.Fatal(err)
			}
			var logs bytes.Buffer
			request := httptest.NewRequest(http.MethodPost, "/internal/v1/recorder/capture/stopped", bytes.NewReader(body))
			request = request.WithContext(context.WithValue(request.Context(), recorderWorkerIdentityContextKey{}, workeridentity.Identity{WorkerID: mustRecorderWorkerID(t, workerTestID), Role: workeridentity.RoleCapture}))
			response := httptest.NewRecorder()
			handler := observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)), observability.RequestLogConfig{Mode: observability.RequestLogErrors})(recorderCaptureStoppedHandler(stoppedCallbackService{err: test.err}))
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d: %s", response.Code, response.Body.String())
			}
			found := false
			for _, raw := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
				if len(raw) == 0 {
					continue
				}
				var line map[string]any
				if err := json.Unmarshal(raw, &line); err != nil {
					t.Fatal(err)
				}
				if line["event"] != "recording.capture_stopped_callback" {
					continue
				}
				found = true
				if line["outcome"] != "accepted" || line["job_id"] != workerTestJob || line["attempt_count"] != float64(2) {
					t.Fatalf("acceptance diagnostic = %v", line)
				}
				if duration, ok := line["duration_ms"].(float64); !ok || duration < 0 {
					t.Fatalf("duration missing: %v", line)
				}
			}
			if found != test.accepted {
				t.Fatalf("acceptance logged = %t, want %t; logs: %s", found, test.accepted, logs.String())
			}
			for _, secret := range []string{"private-lease-token", workerTestID, "private-request-key", workerTestTenant, workerTestEpisode, workerTestRecord} {
				if strings.Contains(logs.String(), secret) {
					t.Fatalf("log contains request data %q", secret)
				}
			}
		})
	}
}

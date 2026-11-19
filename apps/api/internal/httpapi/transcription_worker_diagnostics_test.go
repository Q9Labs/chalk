package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type failingClaimService struct {
	TranscriptWorkerService
	CleanupWorkerService
	TranscriptFinalizerWorkerService
	err error
}

func (s failingClaimService) Claim(context.Context, transcripts.ClaimInput) (transcripts.Assignment, error) {
	return transcripts.Assignment{}, s.err
}

func (s failingClaimService) ClaimFinalizer(context.Context, transcripts.FinalizerClaimInput) (transcripts.FinalizerAssignment, error) {
	return transcripts.FinalizerAssignment{}, s.err
}

func (s failingClaimService) ClaimCleanup(context.Context, transcripts.CleanupClaimInput) (transcripts.CleanupJob, string, error) {
	return transcripts.CleanupJob{}, "", s.err
}

type workloadAuthorizerFunc func(*http.Request) error

func (f workloadAuthorizerFunc) AuthorizeWorkload(_ context.Context, r *http.Request, _ string) error {
	return f(r)
}

var transcriptionClaimRoutes = []string{
	"/internal/v1/transcription/jobs/claim",
	"/internal/v1/transcription/finalize/claim",
	"/internal/v1/transcription/cleanup/claim",
}

// serveTranscriptionWorker mounts every worker route behind the production
// journey and request-logging middleware and returns the structured log.
func serveTranscriptionWorker(t *testing.T, service failingClaimService, auth WorkloadAuthorizer, path string, headers map[string]string) (*httptest.ResponseRecorder, string, []map[string]any) {
	t.Helper()
	var logs bytes.Buffer
	logger := observability.New(observability.Config{}, &logs).Logger()
	router := chi.NewRouter()
	router.Use(observability.JourneyMiddleware, observability.RequestMiddleware(logger))
	mountTranscriptWorkerRoutes(router, service, auth, struct{ ManifestAuthority }{}, struct{ ChunkAuthority }{}, struct{ ResultAuthority }{})
	mountTranscriptFinalizeRoutes(router, service, auth, struct{ FinalizerAuthority }{})
	mountTranscriptCleanupRoutes(router, service, auth, struct{ CleanupDeleteAuthority }{})

	journeyID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"batch_size":1}`))
	request.Header.Set("X-Chalk-Journey-ID", journeyID.String())
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	var lines []map[string]any
	for _, raw := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		if len(raw) == 0 {
			continue
		}
		var line map[string]any
		if err := json.Unmarshal(raw, &line); err != nil {
			t.Fatalf("log line is not JSON: %s", raw)
		}
		lines = append(lines, line)
	}
	return response, journeyID.String(), lines
}

func logLine(lines []map[string]any, event string) map[string]any {
	for _, line := range lines {
		if line["event"] == event {
			return line
		}
	}
	return nil
}

func allowWorkload(*http.Request) error { return nil }

func TestTranscriptionClaimRoutesAnswer503WhenTheDatabaseIsUnavailable(t *testing.T) {
	cause := fmt.Errorf("%w: %w", transcripts.ErrArtifactRepository, errors.New("begin: SQLSTATE 08006"))
	for _, path := range transcriptionClaimRoutes {
		t.Run(path, func(t *testing.T) {
			response, journeyID, lines := serveTranscriptionWorker(t, failingClaimService{err: cause}, workloadAuthorizerFunc(allowWorkload), path, nil)
			if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"service.unavailable"`) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			line := logLine(lines, "http.failure")
			if line == nil || line["code"] != "service.unavailable" || line["journey_id"] != journeyID || !strings.Contains(fmt.Sprint(line["error"]), "SQLSTATE 08006") {
				t.Fatalf("failure log = %v", line)
			}
		})
	}
}

func TestTranscriptionClaimRoutesLogTheCauseOfAnUnknownError(t *testing.T) {
	for _, path := range transcriptionClaimRoutes {
		t.Run(path, func(t *testing.T) {
			response, journeyID, lines := serveTranscriptionWorker(t, failingClaimService{err: errors.New("claim artifact job: unexpected")}, workloadAuthorizerFunc(allowWorkload), path, nil)
			if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"internal.error"`) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "unexpected") {
				t.Fatalf("response leaks the cause: %s", response.Body.String())
			}
			line := logLine(lines, "http.failure")
			if line == nil || line["code"] != "internal.error" || line["journey_id"] != journeyID || !strings.Contains(fmt.Sprint(line["error"]), "claim artifact job: unexpected") {
				t.Fatalf("failure log = %v", line)
			}
		})
	}
}

func TestTranscriptionWorkerRoutesLogWhyAWorkloadWasRejected(t *testing.T) {
	const signature, nonce = "private-signature-value", "private-nonce-value-0123456789"
	rejection := errors.New("workload audience mismatch")
	auth := workloadAuthorizerFunc(func(*http.Request) error { return rejection })
	headers := map[string]string{
		workloadAuthorizationHeader: "Chalk-Workload-HMAC " + signature,
		workloadNonceHeader:         nonce,
		workloadAudienceHeader:      "chalk-api",
	}
	for _, path := range transcriptionClaimRoutes {
		t.Run(path, func(t *testing.T) {
			response, journeyID, lines := serveTranscriptionWorker(t, failingClaimService{}, auth, path, headers)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d: %s", response.Code, response.Body.String())
			}
			line := logLine(lines, "workload.unauthorized")
			if line == nil || line["reason"] != rejection.Error() || line["route"] != path || line["audience"] != "chalk-api" || line["journey_id"] != journeyID {
				t.Fatalf("rejection log = %v", line)
			}
			encoded, err := json.Marshal(lines)
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{signature, nonce} {
				if strings.Contains(string(encoded), secret) {
					t.Fatalf("log contains %q", secret)
				}
			}
		})
	}
}

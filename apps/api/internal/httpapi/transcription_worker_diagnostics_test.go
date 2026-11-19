package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

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

type transcriptionWorkerTestService interface {
	TranscriptWorkerService
	CleanupWorkerService
	TranscriptFinalizerWorkerService
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
func serveTranscriptionWorker(t *testing.T, service transcriptionWorkerTestService, auth WorkloadAuthorizer, path string, headers map[string]string) (*httptest.ResponseRecorder, string, []map[string]any) {
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

type refusingNonceStore struct{}

func (refusingNonceStore) Consume(context.Context, string, time.Duration) (bool, error) {
	return false, errors.New("nonce store down at redis.internal.example:6379")
}

func TestTranscriptionWorkerRoutesLogWhyAWorkloadWasRejected(t *testing.T) {
	const signature, nonce = "private-signature-value", "private-nonce-value-0123456789"
	auth := NewHMACWorkloadAuthorizer(HMACWorkloadAuthorizerConfig{Secret: []byte("test-secret"), Environment: "test", ReleaseID: "release-1", Audience: "chalk-api", Nonces: refusingNonceStore{}})
	now := time.Now().Unix()
	headers := func(override map[string]string) map[string]string {
		values := map[string]string{
			workloadAuthorizationHeader: "Chalk-Workload-HMAC " + signature,
			workloadTimestampHeader:     strconv.FormatInt(now, 10),
			workloadNonceHeader:         nonce,
			workloadEnvironmentHeader:   "test",
			workloadReleaseHeader:       "release-1",
			workloadRoleHeader:          transcriptionWorkloadRole,
			workloadAudienceHeader:      "chalk-api",
			workloadBodySHAHeader:       "not-the-body-digest",
		}
		for name, value := range override {
			values[name] = value
		}
		return values
	}
	for name, test := range map[string]struct {
		headers map[string]string
		reason  string
	}{
		"audience":  {headers(map[string]string{workloadAudienceHeader: "attacker.example:8443"}), "workload audience mismatch"},
		"release":   {headers(map[string]string{workloadReleaseHeader: "release-2"}), "workload release mismatch"},
		"timestamp": {headers(map[string]string{workloadTimestampHeader: "soon"}), "invalid workload timestamp"},
		"checksum":  {headers(nil), "workload body checksum mismatch"},
	} {
		for _, path := range transcriptionClaimRoutes {
			t.Run(name+" "+path, func(t *testing.T) {
				response, journeyID, lines := serveTranscriptionWorker(t, failingClaimService{}, auth, path, test.headers)
				if response.Code != http.StatusUnauthorized {
					t.Fatalf("status = %d: %s", response.Code, response.Body.String())
				}
				line := logLine(lines, "workload.unauthorized")
				if line == nil || line["reason"] != test.reason || line["route"] != path || line["journey_id"] != journeyID {
					t.Fatalf("rejection log = %v", line)
				}
				encoded, err := json.Marshal(lines)
				if err != nil {
					t.Fatal(err)
				}
				for _, private := range []string{signature, nonce, "attacker.example", "release-2", "not-the-body-digest"} {
					if strings.Contains(string(encoded), private) {
						t.Fatalf("log contains %q: %s", private, encoded)
					}
				}
			})
		}
	}
}

func TestWorkloadRejectionLogNamesOnlyAKnownReason(t *testing.T) {
	for name, test := range map[string]struct {
		err    error
		reason string
	}{
		"known":   {fmt.Errorf("wrapped: %w", errWorkloadNonceReplay), "workload nonce replay"},
		"unknown": {errors.New("redis.internal.example:6379 refused"), "unrecognized"},
	} {
		t.Run(name, func(t *testing.T) {
			auth := workloadAuthorizerFunc(func(*http.Request) error { return test.err })
			response, _, lines := serveTranscriptionWorker(t, failingClaimService{}, auth, transcriptionClaimRoutes[0], nil)
			line := logLine(lines, "workload.unauthorized")
			if response.Code != http.StatusUnauthorized || line == nil || line["reason"] != test.reason {
				t.Fatalf("status = %d, log = %v", response.Code, line)
			}
			if encoded, _ := json.Marshal(lines); strings.Contains(string(encoded), "redis.internal.example") {
				t.Fatalf("log contains the authorizer's error text: %s", encoded)
			}
		})
	}
}

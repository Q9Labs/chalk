package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type cleanupAuthStub struct{}

func (cleanupAuthStub) AuthorizeWorkload(context.Context, *http.Request, string) error { return nil }

type cleanupWorkerStub struct {
	job transcripts.CleanupJob
}

func (s cleanupWorkerStub) ClaimCleanup(context.Context, transcripts.CleanupClaimInput) (transcripts.CleanupJob, string, error) {
	return s.job, "lease-token", nil
}
func (s cleanupWorkerStub) CleanupKey(context.Context, transcripts.CleanupLeaseInput) (string, error) {
	return s.job.ObjectKey, nil
}
func (s cleanupWorkerStub) CompleteCleanup(context.Context, transcripts.CleanupLeaseInput) (transcripts.CleanupJob, error) {
	s.job.State = transcripts.CleanupStateCompleted
	now := time.Now()
	s.job.VerifiedAt = &now
	return s.job, nil
}
func (s cleanupWorkerStub) RetryCleanup(context.Context, transcripts.CleanupRetryInput) (transcripts.CleanupJob, error) {
	return s.job, nil
}

type cleanupAuthorityStub struct{ verified string }

func (s *cleanupAuthorityStub) CreateDeleteURL(context.Context, CleanupDeleteURLInput) (string, error) {
	return "https://r2.example/delete", nil
}
func (s *cleanupAuthorityStub) VerifyAbsent(_ context.Context, key string) error {
	s.verified = key
	return nil
}

func TestCleanupClaimContractReturnsExactDeleteAuthority(t *testing.T) {
	id, _ := utilities.NewID()
	expires := time.Now().Add(time.Minute)
	service := cleanupWorkerStub{job: transcripts.CleanupJob{ID: id, Attempt: 1, LeaseExpiresAt: &expires, ObjectKey: "tenants/t/transcripts/x/chunk.json"}}
	authority := &cleanupAuthorityStub{}
	router := chi.NewRouter()
	mountTranscriptCleanupRoutes(router, service, cleanupAuthStub{}, authority)
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/transcription/cleanup/claim", strings.NewReader(`{"batch_size":1}`))
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"delete_url"`) {
		t.Fatalf("cleanup claim response = %d %s", res.Code, res.Body.String())
	}
}

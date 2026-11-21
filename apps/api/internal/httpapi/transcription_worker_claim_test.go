package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type claimFakeService struct {
	TranscriptWorkerService
	queue         []transcripts.Assignment
	claims        int
	released      []transcripts.LeaseInput
	releaseCtxErr []error
}

func (s *claimFakeService) Claim(context.Context, transcripts.ClaimInput) (transcripts.Assignment, error) {
	s.claims++
	if len(s.queue) == 0 {
		return transcripts.Assignment{}, transcripts.ErrNoClaimableJob
	}
	next := s.queue[0]
	s.queue = s.queue[1:]
	return next, nil
}

func (s *claimFakeService) Release(ctx context.Context, input transcripts.LeaseInput) (transcripts.Job, error) {
	s.released = append(s.released, input)
	s.releaseCtxErr = append(s.releaseCtxErr, ctx.Err())
	return transcripts.Job{}, nil
}

type allowWorkload struct{}

func (allowWorkload) AuthorizeWorkload(context.Context, *http.Request, string) error { return nil }

// claimFakeSigner signs every URL except the chunk of the jobs named in failChunk.
type claimFakeSigner struct {
	failChunk map[utilities.ID]bool
	onFail    func()
}

func (s claimFakeSigner) CreateChunkGETURL(_ context.Context, input ChunkURLInput) (string, error) {
	if s.failChunk[input.JobID] {
		if s.onFail != nil {
			s.onFail()
		}
		return "", errors.New("signer down")
	}
	return "https://storage.invalid/chunk", nil
}
func (claimFakeSigner) CreateManifestGETURL(context.Context, ManifestURLInput) (string, error) {
	return "https://storage.invalid/manifest", nil
}
func (claimFakeSigner) CreateResultPUTURL(context.Context, ResultURLInput) (string, error) {
	return "https://storage.invalid/result", nil
}
func (claimFakeSigner) VerifyResult(context.Context, ResultVerification) error { return nil }

func claimTestAssignment(t *testing.T, leaseFor time.Duration) transcripts.Assignment {
	t.Helper()
	newID := func() utilities.ID {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	expires := time.Now().Add(leaseFor)
	manifestKey := "manifest-key"
	return transcripts.Assignment{
		Job:        transcripts.Job{ID: newID(), TenantID: newID(), EpisodeID: newID(), RecordingID: newID(), Attempt: 2, LeaseExpiresAt: &expires},
		LeaseToken: "lease-token-" + newID().String(),
		Chunk:      &transcripts.ChunkInput{ID: newID(), StorageKey: "chunk-key", ResultKey: "result-key", AllocationID: newID()},
		Source:     &transcripts.SourceInput{ExpiresAt: expires},
		Transcript: transcripts.Transcript{SourceManifestKey: &manifestKey},
	}
}

func claimTestRequest(ctx context.Context, batch string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/internal/v1/transcription/jobs/claim", strings.NewReader(`{"batch_size":`+batch+`}`)).WithContext(ctx)
}

func claimResponseJobs(t *testing.T, recorder *httptest.ResponseRecorder) []string {
	t.Helper()
	var body workerClaimResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("claim response is not JSON: %v", err)
	}
	jobs := make([]string, len(body.Assignments))
	for i, assignment := range body.Assignments {
		jobs[i] = assignment.JobID
	}
	return jobs
}

func TestClaimReleasesTheLeaseItCannotHandOver(t *testing.T) {
	t.Run("a signing failure on the only job answers unavailable and frees the chunk", func(t *testing.T) {
		job := claimTestAssignment(t, time.Hour)
		service := &claimFakeService{queue: []transcripts.Assignment{job}}
		signer := claimFakeSigner{failChunk: map[utilities.ID]bool{job.Job.ID: true}}
		recorder := httptest.NewRecorder()
		workerClaimHandler(service, allowWorkload{}, signer, signer, signer)(recorder, claimTestRequest(t.Context(), "1"))

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status %d, want 503", recorder.Code)
		}
		assertReleased(t, service, job)
	})

	t.Run("a failure after earlier jobs returns those jobs and frees only the failed one", func(t *testing.T) {
		first, second := claimTestAssignment(t, time.Hour), claimTestAssignment(t, time.Hour)
		service := &claimFakeService{queue: []transcripts.Assignment{first, second}}
		signer := claimFakeSigner{failChunk: map[utilities.ID]bool{second.Job.ID: true}}
		recorder := httptest.NewRecorder()
		workerClaimHandler(service, allowWorkload{}, signer, signer, signer)(recorder, claimTestRequest(t.Context(), "5"))

		if recorder.Code != http.StatusOK {
			t.Fatalf("status %d, want 200", recorder.Code)
		}
		if jobs := claimResponseJobs(t, recorder); len(jobs) != 1 || jobs[0] != first.Job.ID.String() {
			t.Fatalf("assignments %v, want only the first job", jobs)
		}
		assertReleased(t, service, second)
	})

	t.Run("an incomplete assignment is freed", func(t *testing.T) {
		job := claimTestAssignment(t, time.Hour)
		job.Transcript.SourceManifestKey = nil
		service := &claimFakeService{queue: []transcripts.Assignment{job}}
		recorder := httptest.NewRecorder()
		workerClaimHandler(service, allowWorkload{}, claimFakeSigner{}, claimFakeSigner{}, claimFakeSigner{})(recorder, claimTestRequest(t.Context(), "1"))

		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("status %d, want 500", recorder.Code)
		}
		assertReleased(t, service, job)
	})

	t.Run("an assignment whose lease already ran out is freed", func(t *testing.T) {
		job := claimTestAssignment(t, -time.Second)
		service := &claimFakeService{queue: []transcripts.Assignment{job}}
		recorder := httptest.NewRecorder()
		workerClaimHandler(service, allowWorkload{}, claimFakeSigner{}, claimFakeSigner{}, claimFakeSigner{})(recorder, claimTestRequest(t.Context(), "1"))

		if recorder.Code != http.StatusConflict {
			t.Fatalf("status %d, want 409", recorder.Code)
		}
		assertReleased(t, service, job)
	})

	t.Run("the release still runs when the request was cancelled", func(t *testing.T) {
		job := claimTestAssignment(t, time.Hour)
		service := &claimFakeService{queue: []transcripts.Assignment{job}}
		ctx, cancel := context.WithCancel(t.Context())
		signer := claimFakeSigner{failChunk: map[utilities.ID]bool{job.Job.ID: true}, onFail: cancel}
		workerClaimHandler(service, allowWorkload{}, signer, signer, signer)(httptest.NewRecorder(), claimTestRequest(ctx, "1"))

		assertReleased(t, service, job)
	})
}

func assertReleased(t *testing.T, service *claimFakeService, job transcripts.Assignment) {
	t.Helper()
	if len(service.released) != 1 {
		t.Fatalf("released %d leases, want 1", len(service.released))
	}
	got := service.released[0]
	if got.JobID != job.Job.ID || got.Attempt != job.Job.Attempt || got.LeaseToken != job.LeaseToken || got.LeaseOwner != transcriptionWorkloadRole {
		t.Fatalf("released %+v, want the lease that was just taken", got)
	}
	if err := service.releaseCtxErr[0]; err != nil {
		t.Fatalf("release ran on a cancelled context: %v", err)
	}
}

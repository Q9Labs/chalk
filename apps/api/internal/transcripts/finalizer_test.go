package transcripts

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type finalizerRepositoryStub struct{ claimed FinalizerAssignment }

func (s finalizerRepositoryStub) ClaimFinalizer(context.Context, FinalizerClaimInput) (FinalizerAssignment, error) {
	return s.claimed, nil
}
func (s finalizerRepositoryStub) FinalizerKey(context.Context, LeaseInput) (string, error) {
	return "tenants/t/transcripts/x/document.json", nil
}
func (s finalizerRepositoryStub) CompleteFinalizer(_ context.Context, input FinalizerCompleteInput) (Transcript, error) {
	return Transcript{ID: input.JobID, Status: StatusComplete}, nil
}
func (s finalizerRepositoryStub) RetryFinalizer(context.Context, RetryInput) (Job, error) {
	return Job{}, nil
}

func TestFinalizerClaimPreservesOrderedChunkResults(t *testing.T) {
	jobID, _ := utilities.NewID()
	transcriptID, _ := utilities.NewID()
	stub := finalizerRepositoryStub{claimed: FinalizerAssignment{Job: Job{ID: jobID}, Transcript: Transcript{ID: transcriptID}, Chunks: []FinalizerChunk{{StartMS: 0, EndMS: 1000}, {StartMS: 1000, EndMS: 2000}}}}
	service := Service{finalizer: stub}
	assignment, err := service.ClaimFinalizer(context.Background(), FinalizerClaimInput{Owner: "transcription-dispatcher", LeaseDuration: time.Minute, Now: time.Now()})
	if err != nil || len(assignment.Chunks) != 2 || assignment.Chunks[1].StartMS != 1000 {
		t.Fatalf("finalizer assignment = %#v, err=%v", assignment, err)
	}
}

func TestFinalizerCompleteRejectsUnverifiedMetadata(t *testing.T) {
	service := Service{finalizer: finalizerRepositoryStub{}}
	if _, err := service.CompleteFinalizer(context.Background(), FinalizerCompleteInput{Attempt: 1, LeaseToken: "lease", ArtifactSize: 10, ArtifactContentType: "application/json"}); err == nil {
		t.Fatal("invalid finalizer job accepted")
	}
}

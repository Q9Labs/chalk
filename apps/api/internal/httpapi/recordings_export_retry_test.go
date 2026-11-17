package httpapi

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// retryingRecordings answers as the database does: a failed Recording is in flight again once its
// export has been requeued.
type retryingRecordings struct {
	requeued *bool
	failure  string
}

func (s retryingRecordings) Get(context.Context, utilities.ID, utilities.ID) (recordings.Recording, error) {
	if *s.requeued {
		return recordings.Recording{Status: "pending"}, nil
	}
	return recordings.Recording{Status: "failed", FailureCode: &s.failure}, nil
}

func (retryingRecordings) List(context.Context, utilities.ID, utilities.ID, utilities.ID, pagination.PageRequest) (recordings.RecordingList, error) {
	return recordings.RecordingList{}, nil
}

type requeuingExports struct{ requeued *bool }

func (s requeuingExports) RequestExport(context.Context, recordingpipeline.ExportInput) (recordingpipeline.Job, error) {
	*s.requeued = true
	return recordingpipeline.Job{}, nil
}

func (s requeuingExports) GetArtifactState(context.Context, utilities.ID, utilities.ID) (recordingpipeline.ArtifactState, error) {
	if *s.requeued {
		return recordingpipeline.ArtifactState{ExportStatus: recordingpipeline.ExportStatusPending}, nil
	}
	return recordingpipeline.ArtifactState{ExportStatus: recordingpipeline.ExportStatusFailed}, nil
}

// A retried export answers with the Recording the retry produced, not the failure it just cleared.
func TestExportRetryAnswersWithTheReopenedRecording(t *testing.T) {
	requeued := false
	endpoint := requestRecordingExportEndpoint(retryingRecordings{requeued: &requeued, failure: "render_commit_failed"}, requeuingExports{requeued: &requeued}, nil)
	response, err := endpoint.handle(t.Context(), requestRecordingExportEndpointRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if response.Recording.Status != "pending" || response.Recording.FailureCode != nil {
		t.Fatalf("retry answered status %q failure %v, want pending without a failure", response.Recording.Status, response.Recording.FailureCode)
	}
}

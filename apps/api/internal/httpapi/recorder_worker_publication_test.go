package httpapi

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureStopPublicationFailureRetainsStageAcrossAPI(t *testing.T) {
	response := recorderWorkerAPIError(fmt.Errorf("complete capture: %w", recordingpipeline.ErrCaptureStopPublication))
	if response.Status != http.StatusServiceUnavailable || response.Code != "recording.capture_stop_publication_failed" {
		t.Fatalf("publication stage lost: %+v", response)
	}
}

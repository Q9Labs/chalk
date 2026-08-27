package httpapi

import (
	"errors"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

func TestTranscriptArtifactAPIErrorMapsDisabledPolicy(t *testing.T) {
	apiError, ok := transcriptArtifactAPIError(transcripts.ErrTranscriptionDisabled)
	if !ok {
		t.Fatal("disabled transcription error was not mapped")
	}
	if apiError.Status != http.StatusConflict || apiError.Code != "transcript.disabled" {
		t.Fatalf("disabled transcription API error = %#v", apiError)
	}

	contract := requestTranscriptEndpoint(nil, nil).RouteContract()
	for _, declared := range contract.Errors {
		if declared.Code == apiError.Code {
			return
		}
	}
	t.Fatalf("requestTranscript contract does not declare %q", apiError.Code)
}

func TestTranscriptArtifactAPIErrorDoesNotCollapseDisabledIntoRequestInvalid(t *testing.T) {
	apiError, ok := transcriptArtifactAPIError(errors.Join(transcripts.ErrTranscriptionDisabled, errors.New("policy")))
	if !ok || apiError.Code != "transcript.disabled" {
		t.Fatalf("wrapped disabled transcription API error = %#v, mapped = %t", apiError, ok)
	}
}

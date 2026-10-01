package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

func TestTranscriptDownloadLifetime(t *testing.T) {
	tenantID := mustTestID(t, "00000000-0000-4000-8000-000000000001")
	transcriptID := mustTestID(t, "00000000-0000-4000-8000-000000000002")
	key := "tenants/" + tenantID.String() + "/transcripts/test.json"
	service := documentTranscriptServiceStub{transcript: transcripts.Transcript{ID: transcriptID, TenantID: tenantID, Status: transcripts.StatusComplete, ArtifactKey: &key}}
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalSystem})
	for _, seconds := range []int{-1, 0, 1, 300, 301, 86400, int(^uint(0) >> 1)} {
		t.Run(fmt.Sprint(seconds), func(t *testing.T) {
			downloads := &recordingDownloadHTTPStub{signedAt: time.Now()}
			endpoint := transcriptArtifactDownloadEndpoint(service, downloads, &documentAuthorizer{})
			_, err := endpoint.handle(ctx, createTranscriptDownloadRequest{TenantID: tenantID, TranscriptID: transcriptID, Body: createTranscriptDownloadBody{ExpiresInSeconds: seconds}})
			if seconds < 1 || seconds > 300 {
				if !errors.Is(err, apiErrorInvalidURLExpiration) || downloads.calls != 0 {
					t.Fatalf("invalid lifetime: error = %v, signing calls = %d", err, downloads.calls)
				}
				return
			}
			if err != nil || downloads.calls != 1 || downloads.input.ExpiresIn != time.Duration(seconds)*time.Second {
				t.Fatalf("valid lifetime: error = %v, signing calls = %d, duration = %v", err, downloads.calls, downloads.input.ExpiresIn)
			}
		})
	}
}

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

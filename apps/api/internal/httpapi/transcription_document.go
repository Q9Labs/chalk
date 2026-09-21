package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type transcriptDocumentRequest struct {
	TenantID     utilities.ID
	TranscriptID utilities.ID
}

type transcriptDocumentResponse struct {
	SchemaVersion string                  `json:"schema_version"`
	TranscriptID  string                  `json:"transcript_id"`
	RecordingID   string                  `json:"recording_id"`
	EpisodeID     string                  `json:"episode_id"`
	Cues          []transcriptDocumentCue `json:"cues"`
}

type transcriptDocumentCue struct {
	StartMS  int64                          `json:"start_ms"`
	EndMS    int64                          `json:"end_ms"`
	Text     string                         `json:"text"`
	Overlap  bool                           `json:"overlap"`
	Identity *transcriptDocumentCueIdentity `json:"identity,omitempty"`
}

type transcriptDocumentCueIdentity struct {
	ParticipantRef        string  `json:"participant_ref"`
	ParticipantGeneration int64   `json:"participant_generation"`
	TrackID               string  `json:"track_id"`
	TrackEpoch            string  `json:"track_epoch"`
	DisplayName           *string `json:"display_name,omitempty"`
}

func transcriptDocumentEndpoint(service TranscriptArtifactService, objects RecordingObjectService, authorizer TenantAuthorizer) Endpoint[transcriptDocumentRequest, transcriptDocumentResponse] {
	return Get("/v1/tenants/{tenant_id}/transcripts/{transcript_id}/document", "/tenants/{tenant_id}/transcripts/{transcript_id}/document", "getTranscriptDocument", decodeTranscriptDocumentRequest, func(ctx context.Context, request transcriptDocumentRequest) (transcriptDocumentResponse, error) {
		if service == nil || objects == nil {
			return transcriptDocumentResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, authorization.TenantPermission{Scope: authentication.ScopeTranscriptionsRead, MinimumRole: memberships.RoleObserver}); err != nil {
			return transcriptDocumentResponse{}, err
		}

		transcript, err := service.Get(ctx, request.TenantID, request.TranscriptID)
		if err != nil {
			return transcriptDocumentResponse{}, err
		}
		if !transcriptDocumentReady(transcript) {
			return transcriptDocumentResponse{}, apiErrorTranscriptNotReady
		}

		artifact, err := objects.GetObject(ctx, *transcript.ArtifactKey)
		if err != nil {
			return transcriptDocumentResponse{}, err
		}
		if !transcriptDocumentArtifactMatches(transcript, artifact) {
			if artifact.Body != nil {
				_ = artifact.Body.Close()
			}
			return transcriptDocumentResponse{}, apiErrorInternal
		}

		document, readErr := transcripts.ReadDocument(artifact.Body, transcripts.MaxDocumentBytes)
		closeErr := artifact.Body.Close()
		if readErr != nil || closeErr != nil {
			return transcriptDocumentResponse{}, apiErrorInternal
		}

		return newTranscriptDocumentResponse(transcript, document), nil
	}).Auth(APIAuthCookieOrBearer).Parameters(tenantIDParameter(), transcriptIDParameter()).Responds(http.StatusOK, "TranscriptDocument", transcriptDocumentResponse{}).Errors(transcriptReadErrors(apiErrorInvalidTranscriptID, apiErrorTranscriptNotFound, apiErrorTranscriptNotReady, apiErrorRecordingArtifactNotFound)...).MapErrors(transcriptDocumentAPIError)
}

func decodeTranscriptDocumentRequest(r *http.Request) (transcriptDocumentRequest, error) {
	tenantID, transcriptID, err := tenantTranscriptIDsRequest(r)
	if err != nil {
		return transcriptDocumentRequest{}, err
	}
	return transcriptDocumentRequest{TenantID: tenantID, TranscriptID: transcriptID}, nil
}

func transcriptDocumentReady(transcript transcripts.Transcript) bool {
	return transcript.Status == transcripts.StatusComplete && transcript.DeletedAt == nil && transcript.ArtifactKey != nil && transcript.ArtifactSize != nil && *transcript.ArtifactSize > 0 && *transcript.ArtifactSize <= transcripts.MaxDocumentBytes && transcript.ArtifactContentType != nil && *transcript.ArtifactContentType == "application/json"
}

func transcriptDocumentArtifactMatches(transcript transcripts.Transcript, artifact objectstorage.ObjectReader) bool {
	return artifact.Body != nil && artifact.Key == *transcript.ArtifactKey && artifact.Size == *transcript.ArtifactSize && artifact.ContentType == *transcript.ArtifactContentType && artifact.Size <= transcripts.MaxDocumentBytes
}

func newTranscriptDocumentResponse(transcript transcripts.Transcript, document transcripts.Document) transcriptDocumentResponse {
	response := transcriptDocumentResponse{
		SchemaVersion: document.SchemaVersion,
		TranscriptID:  transcript.ID.String(),
		RecordingID:   transcript.RecordingID.String(),
		EpisodeID:     transcript.EpisodeID.String(),
		Cues:          make([]transcriptDocumentCue, 0, len(document.Cues)),
	}
	for _, cue := range document.Cues {
		response.Cues = append(response.Cues, transcriptDocumentCue{
			StartMS: cue.StartMS,
			EndMS:   cue.EndMS,
			Text:    cue.Text,
			Overlap: cue.Overlap,
			Identity: &transcriptDocumentCueIdentity{
				ParticipantRef:        cue.Identity.ParticipantRef,
				ParticipantGeneration: cue.Identity.ParticipantGeneration,
				TrackID:               cue.Identity.TrackID,
				TrackEpoch:            cue.Identity.TrackEpoch,
				DisplayName:           cue.Identity.DisplayName,
			},
		})
	}
	return response
}

func transcriptDocumentAPIError(err error) (APIError, bool) {
	if apiErr, ok := transcriptArtifactAPIError(err); ok {
		return apiErr, true
	}
	if apiErr, ok := objectStorageAPIError(err); ok {
		return apiErr, true
	}
	if errors.Is(err, transcripts.ErrDocumentTooLarge) || errors.Is(err, transcripts.ErrInvalidDocument) {
		return apiErrorInternal, true
	}
	return APIError{}, false
}

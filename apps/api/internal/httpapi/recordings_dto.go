package httpapi

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingResponse struct {
	ID                       string                                    `json:"id"`
	TenantID                 string                                    `json:"tenant_id"`
	SpaceID                  string                                    `json:"space_id"`
	EpisodeID                string                                    `json:"episode_id"`
	Status                   string                                    `json:"status"`
	StorageProvider          string                                    `json:"storage_provider"`
	StorageKey               *string                                   `json:"storage_key"`
	Metadata                 any                                       `json:"metadata"`
	Source                   recordingSourceResponse                   `json:"source"`
	Export                   recordingExportResponse                   `json:"export"`
	TranscriptionPolicy      artifactpolicy.TranscriptionMode          `json:"transcription_policy"`
	TranscriptionPreparation recordingTranscriptionPreparationResponse `json:"transcription_preparation"`
	UpdatedAt                string                                    `json:"updated_at"`
	CreatedAt                string                                    `json:"created_at"`
}

type recordingListResponse struct {
	Recordings []recordingResponse `json:"recordings"`
	Pagination paginationResponse  `json:"pagination"`
}

type recordingDownloadURLResponse struct {
	Method       string              `json:"method"`
	URL          string              `json:"url"`
	SignedAt     string              `json:"signed_at"`
	ExpiresAt    string              `json:"expires_at"`
	SignedHeader map[string][]string `json:"signed_headers"`
}

type recordingExportResponse struct {
	JobID           string  `json:"job_id,omitempty"`
	Status          string  `json:"status"`
	Retryable       bool    `json:"retryable"`
	SourceExpiresAt *string `json:"source_expires_at,omitempty"`
	FailureCode     *string `json:"failure_code,omitempty"`
	FailureMessage  *string `json:"failure_message,omitempty"`
}

type recordingSourceResponse struct {
	StopReason string  `json:"stop_reason,omitempty"`
	Status     string  `json:"status"`
	ExpiresAt  *string `json:"expires_at,omitempty"`
}

type recordingTranscriptionPreparationResponse struct {
	Status      recordingpipeline.TranscriptionPreparationStatus `json:"status"`
	ExpiresAt   *string                                          `json:"expires_at,omitempty"`
	FailureCode string                                           `json:"failure_code,omitempty"`
}

type requestRecordingExportResponse struct {
	Recording recordingResponse       `json:"recording"`
	Export    recordingExportResponse `json:"export"`
}

type createRecordingDownloadURLRequest struct {
	ExpiresInSeconds int  `json:"expires_in_seconds"`
	Download         bool `json:"download,omitempty"`
}

type listRecordingsRequest struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
	EpisodeID utilities.ID
	Page      pagination.PageRequest
}

type getRecordingRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
}

type createRecordingDownloadURLEndpointRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	Body        createRecordingDownloadURLRequest
}

type requestRecordingExportEndpointRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
}

func newRecordingListResponse(ctx context.Context, list recordings.RecordingList, artifacts RecordingExportService) (recordingListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return recordingListResponse{}, err
	}

	states := make(map[utilities.ID]recordingpipeline.ArtifactState, len(list.Recordings))
	if batch, ok := artifacts.(recordingArtifactStateBatchService); ok && len(list.Recordings) > 0 {
		recordingIDs := make([]utilities.ID, 0, len(list.Recordings))
		for _, recording := range list.Recordings {
			recordingIDs = append(recordingIDs, recording.ID)
		}
		states, err = batch.GetArtifactStates(ctx, list.Recordings[0].TenantID, recordingIDs)
		if err != nil {
			return recordingListResponse{}, err
		}
	} else {
		for _, recording := range list.Recordings {
			state, stateErr := artifacts.GetArtifactState(ctx, recording.TenantID, recording.ID)
			if stateErr != nil {
				return recordingListResponse{}, stateErr
			}
			states[recording.ID] = state
		}
	}

	response := recordingListResponse{Recordings: make([]recordingResponse, 0, len(list.Recordings)), Pagination: page}
	for _, recording := range list.Recordings {
		state, ok := states[recording.ID]
		if !ok {
			return recordingListResponse{}, recordingpipeline.ErrPipelineNotFound
		}
		response.Recordings = append(response.Recordings, newRecordingResponse(recording, state))
	}
	return response, nil
}

func newRecordingResponse(recording recordings.Recording, state recordingpipeline.ArtifactState) recordingResponse {
	return recordingResponse{
		ID:                       recording.ID.String(),
		TenantID:                 recording.TenantID.String(),
		SpaceID:                  recording.SpaceID.String(),
		EpisodeID:                recording.EpisodeID.String(),
		Status:                   recording.Status,
		StorageProvider:          recording.StorageProvider,
		StorageKey:               recording.StorageKey,
		Metadata:                 rawJSONValue(recording.Metadata),
		Source:                   newRecordingSourceResponse(state),
		Export:                   newRecordingExportResponse(state),
		TranscriptionPolicy:      state.TranscriptionPolicy,
		TranscriptionPreparation: newRecordingTranscriptionPreparationResponse(state),
		UpdatedAt:                utilities.FormatTimestamp(recording.UpdatedAt),
		CreatedAt:                utilities.FormatTimestamp(recording.CreatedAt),
	}
}

func newRecordingTranscriptionPreparationResponse(state recordingpipeline.ArtifactState) recordingTranscriptionPreparationResponse {
	response := recordingTranscriptionPreparationResponse{Status: state.TranscriptionPreparationStatus, FailureCode: state.TranscriptionFailureCode}
	if state.TranscriptionSourceExpiresAt != nil {
		expiresAt := utilities.FormatTimestamp(*state.TranscriptionSourceExpiresAt)
		response.ExpiresAt = &expiresAt
	}
	return response
}

func newRecordingSourceResponse(state recordingpipeline.ArtifactState) recordingSourceResponse {
	response := recordingSourceResponse{Status: string(state.SourceStatus), StopReason: state.CaptureStopReason}
	if state.SourceExpiresAt != nil {
		expiresAt := utilities.FormatTimestamp(*state.SourceExpiresAt)
		response.ExpiresAt = &expiresAt
	}
	return response
}

func newRecordingExportResponse(state recordingpipeline.ArtifactState) recordingExportResponse {
	response := recordingExportResponse{Status: string(state.ExportStatus), Retryable: state.Retryable}
	if state.ExportJobID != nil {
		response.JobID = state.ExportJobID.String()
	}
	if state.SourceExpiresAt != nil {
		expiresAt := utilities.FormatTimestamp(*state.SourceExpiresAt)
		response.SourceExpiresAt = &expiresAt
	}
	if state.FailureCode != "" {
		failureCode := state.FailureCode
		response.FailureCode = &failureCode
	}
	if state.FailureMessage != "" {
		failureMessage := state.FailureMessage
		response.FailureMessage = &failureMessage
	}
	return response
}

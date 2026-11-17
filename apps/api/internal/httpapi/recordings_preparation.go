package httpapi

import (
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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

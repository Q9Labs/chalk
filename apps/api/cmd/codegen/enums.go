package main

import (
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

func fieldEnum(schemaName string, fieldName string) []string {
	if values := telemetryFieldEnum(schemaName, fieldName); values != nil {
		return values
	}
	if schemaName == "ChalkSFUSignalRequest" {
		if values := httpapi.SFUSignalFieldEnum(fieldName); values != nil {
			return values
		}
	}
	if values := mediaPlaneFieldEnum(schemaName, fieldName); values != nil {
		return values
	}
	switch fieldName {
	case "transcript_language":
		return artifactpolicy.TranscriptLanguageValues()
	case "recording_render_mode":
		return []string{"on_demand", "automatic"}
	case "admission":
		if schemaName == "AdmitEpisodeParticipantRequest" {
			return []string{string(episodes.AdmissionPolicy), string(episodes.AdmissionDirect)}
		}
	case "identity_kind":
		if schemaName == "AdmitEpisodeParticipantRequest" {
			return []string{string(episodes.IdentityKindUser), string(episodes.IdentityKindAgent)}
		}
	case "role":
		switch schemaName {
		case "Membership", "MembershipList", "CreateMembershipRequest", "UpdateMembershipRequest":
			return []string{"owner", "collaborator", "observer"}
		default:
			// Episode participant roles are customer-defined space roles. They
			// must remain open strings in the generated API contract.
			return nil
		}
	case "storage_provider":
		return []string{"r2"}
	case "status":
		return resourceStatusEnum(schemaName)
	}
	return nil
}

func mediaPlaneFieldEnum(schemaName string, fieldName string) []string {
	switch fieldName {
	case "default_media_plane":
		return []string{"chalk_sfu"}
	case "media_plane_setting", "effective_media_plane":
		return []string{"chalk_sfu"}
	case "provider":
		if schemaName == "AccessGrant" || schemaName == "ParticipantLifecycle" {
			return []string{"chalk_sfu"}
		}
	case "media_plane":
		if schemaName == "Space" || schemaName == "CreateSpaceRequest" || schemaName == "UpdateSpaceRequest" {
			return []string{"chalk_sfu"}
		}
	}
	return nil
}

func resourceStatusEnum(schemaName string) []string {
	switch schemaName {
	case "Episode", "EpisodeList", "CreateEpisodeRequest", "UpdateEpisodeRequest", "ParticipantEpisodeStatus":
		return []string{"active", "ending", "ended"}
	case "Recording", "RecordingList", "CreateRecordingRequest", "UpdateRecordingRequest":
		return []string{recordings.StatusPending, recordings.StatusProcessing, recordings.StatusCompleted, recordings.StatusFailed}
	case "Transcript", "TranscriptList", "CreateTranscriptRequest", "UpdateTranscriptRequest":
		return []string{
			transcripts.StatusNotRequested, transcripts.StatusPreparing, transcripts.StatusTranscribing, transcripts.StatusVerifying,
			transcripts.StatusComplete, transcripts.StatusRetryableFailure, transcripts.StatusTerminalFailure, transcripts.StatusDeleted,
			transcripts.StatusPending, transcripts.StatusProcessing, transcripts.StatusCompleted, transcripts.StatusFailed,
		}
	}
	return nil
}

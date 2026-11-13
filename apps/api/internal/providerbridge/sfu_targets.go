package providerbridge

import (
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
)

type publicationTarget struct {
	publication provideroperations.Publication
	reference   mediapublications.Reference
}

func operationTargets(publications []provideroperations.Publication, input provideroperations.OperationInput) ([]publicationTarget, *ExecutionResult) {
	targets := make([]publicationTarget, 0, len(publications))
	for _, publication := range publications {
		if publication.PublicationID == "" || !publicationMatchesOperation(publication, input) {
			continue
		}
		reference, err := mediapublications.ParseReference(publication.PublicationID)
		if err != nil {
			result := ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "invalid_publication_reference"}
			return nil, &result
		}
		if !reference.HasMID || !reference.HasParticipantGeneration {
			result := ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "legacy_publication_reference"}
			return nil, &result
		}
		if input.Effect != provideroperations.EffectEndEpisode && reference.ParticipantGeneration != input.ParticipantGeneration {
			continue
		}
		targets = append(targets, publicationTarget{publication: publication, reference: reference})
	}
	return targets, nil
}

func publicationMatchesOperation(publication provideroperations.Publication, input provideroperations.OperationInput) bool {
	switch input.Effect {
	case provideroperations.EffectRevokePublication:
		return publication.ParticipantID == input.ParticipantID && (publication.Source == input.PublicationSource || publication.Source.IsCompanionOf(input.PublicationSource))
	case provideroperations.EffectRemoveParticipant:
		return publication.ParticipantID == input.ParticipantID
	case provideroperations.EffectEndEpisode:
		return true
	default:
		return false
	}
}

func providerExecutionFailure(err error) ExecutionResult {
	switch {
	case errors.Is(err, mediaplane.ErrUnsupportedOperation):
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "unsupported_effect"}
	case errors.Is(err, mediaplane.ErrProviderFailed):
		reason := "provider_result_ambiguous"
		var failure interface{ ProviderFailureCode() string }
		if errors.As(err, &failure) {
			reason = "provider_" + failure.ProviderFailureCode()
		}
		return ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous, Reason: reason}
	case errors.Is(err, mediaplane.ErrProviderUnauthorized):
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "provider_unauthorized"}
	case errors.Is(err, mediaplane.ErrProviderRateLimited):
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "provider_rate_limited"}
	default:
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "provider_unavailable"}
	}
}

func recordingExecutionFailure(err error) ExecutionResult {
	switch {
	case errors.Is(err, tenantlimits.ErrRecordingLimitReached):
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: tenantlimits.RecordingLimitReason}
	case errors.Is(err, provideroperations.ErrInvalidRecordingReservation),
		errors.Is(err, provideroperations.ErrInvalidOperationID):
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "recording_invalid_envelope"}
	case errors.Is(err, recordingpipeline.ErrRecordingCapacityUnavailable),
		errors.Is(err, recordingpipeline.ErrCapacityExceeded):
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "recording_capacity_unavailable"}
	case errors.Is(err, recordingpipeline.ErrCaptureUnsupported):
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "recording_capture_unsupported"}
	case errors.Is(err, recordingpipeline.ErrReservationConflict),
		errors.Is(err, recordingpipeline.ErrStopConflict),
		errors.Is(err, recordingpipeline.ErrInvalidStateTransition),
		errors.Is(err, recordingpipeline.ErrPipelineNotFound),
		errors.Is(err, recordingpipeline.ErrInvalidRecordingID):
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "recording_terminal_state"}
	default:
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "recording_unavailable"}
	}
}

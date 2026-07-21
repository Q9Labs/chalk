package providerbridge

import (
	"context"
	"errors"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

type TrackCloser interface {
	CloseTracks(context.Context, mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error)
}

type SFUExecutor struct {
	publications mediapublications.Registry
	tracks       TrackCloser
}

func NewSFUExecutor(publications mediapublications.Registry, tracks TrackCloser) SFUExecutor {
	return SFUExecutor{publications: publications, tracks: tracks}
}

func (e SFUExecutor) Dispatch(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	return e.execute(ctx, input)
}

func (e SFUExecutor) Reconcile(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	return e.execute(ctx, input)
}

func (e SFUExecutor) execute(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	if e.publications == nil || e.tracks == nil {
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "executor_unavailable"}
	}
	switch input.Effect {
	case provideroperations.EffectRevokePublication, provideroperations.EffectRemoveParticipant:
		if input.ParticipantSessionGeneration <= 0 {
			return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "participant_generation_required"}
		}
	case provideroperations.EffectEndSession:
	case provideroperations.EffectGrantPublication, provideroperations.EffectStartRecording, provideroperations.EffectStopRecording:
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "unsupported_effect"}
	default:
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "unsupported_effect"}
	}

	snapshot, err := e.publications.Latest(ctx, input.TenantID, input.SessionID)
	if err != nil {
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "observation_unavailable"}
	}
	targets, result := operationTargets(snapshot.Publications, input)
	if result != nil {
		return *result
	}
	if len(targets) == 0 {
		return ExecutionResult{Outcome: provideroperations.OutcomeSatisfied}
	}

	connections := make(map[string][]publicationTarget)
	for _, target := range targets {
		connections[target.reference.ConnectionID] = append(connections[target.reference.ConnectionID], target)
	}
	connectionIDs := make([]string, 0, len(connections))
	for connectionID := range connections {
		connectionIDs = append(connectionIDs, connectionID)
	}
	sort.Strings(connectionIDs)
	for _, connectionID := range connectionIDs {
		connectionTargets := connections[connectionID]
		tracks := make([]mediaplane.CloseTrack, 0, len(connectionTargets))
		for _, target := range connectionTargets {
			tracks = append(tracks, mediaplane.CloseTrack{Mid: target.reference.MID, Source: target.publication.Source, PublicationID: target.publication.PublicationID})
		}
		_, err := e.tracks.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: connectionID, Tracks: tracks, Force: true,
		})
		if errors.Is(err, mediaplane.ErrSessionNotFound) {
			err = nil
		}
		if err != nil {
			return providerExecutionFailure(err)
		}
		for _, target := range connectionTargets {
			if err := e.publications.RecordClosedPublication(ctx, mediapublications.CloseInput{
				TenantID: input.TenantID, SessionID: input.SessionID, ParticipantSessionID: target.publication.ParticipantSessionID,
				ParticipantGeneration: target.reference.ParticipantGeneration, ConnectionID: connectionID,
				MID: target.reference.MID, Source: target.publication.Source, PublicationID: target.publication.PublicationID,
			}); err != nil {
				return ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous, Reason: "observation_update_failed"}
			}
		}
	}
	return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

type publicationTarget struct {
	publication provideroperations.Publication
	reference   mediapublications.Reference
}

func operationTargets(publications []provideroperations.Publication, input provideroperations.OperationInput) ([]publicationTarget, *ExecutionResult) {
	targets := make([]publicationTarget, 0, len(publications))
	for _, publication := range publications {
		if !publication.Enabled || publication.PublicationID == "" || !publicationMatchesOperation(publication, input) {
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
		if input.Effect != provideroperations.EffectEndSession && reference.ParticipantGeneration != input.ParticipantSessionGeneration {
			continue
		}
		targets = append(targets, publicationTarget{publication: publication, reference: reference})
	}
	return targets, nil
}

func publicationMatchesOperation(publication provideroperations.Publication, input provideroperations.OperationInput) bool {
	switch input.Effect {
	case provideroperations.EffectRevokePublication:
		return publication.ParticipantSessionID == input.ParticipantSessionID && publication.Source == input.PublicationSource
	case provideroperations.EffectRemoveParticipant:
		return publication.ParticipantSessionID == input.ParticipantSessionID
	case provideroperations.EffectEndSession:
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
		return ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous, Reason: "provider_result_ambiguous"}
	case errors.Is(err, mediaplane.ErrProviderUnauthorized):
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "provider_unauthorized"}
	case errors.Is(err, mediaplane.ErrProviderRateLimited):
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "provider_rate_limited"}
	default:
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "provider_unavailable"}
	}
}

package providerbridge

import (
	"context"
	"errors"
	"log/slog"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TrackCloser interface {
	CloseTracks(context.Context, mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error)
}

// RecordingController owns the Chalk Recording aggregate. The SFU executor
// only dispatches the durable effect; it does not allocate a competing
// Recording identity or perform media capture.
type RecordingController interface {
	Start(context.Context, provideroperations.OperationInput) error
	Stop(context.Context, provideroperations.OperationInput) error
}

// EpisodeProviders reads the provider frozen into an Episode's binding. It
// returns an empty name for an Episode that predates the binding, which ran on
// Cloudflare.
type EpisodeProviders interface {
	ProviderOf(ctx context.Context, tenantID, episodeID utilities.ID) (string, error)
}

// ChalkCleanup is the own SFU's cleanup surface: it closes tracks and ends the
// Episode's sessions and reservations.
type ChalkCleanup interface {
	TrackCloser
	EndEpisode(context.Context, mediaplane.EndEpisodeInput) error
}

type SFUExecutor struct {
	publications mediapublications.Registry
	tracks       TrackCloser
	recording    RecordingController
	episodes     EpisodeProviders
	chalk        ChalkCleanup
}

// WithChalkSFU makes cleanup follow the Episode's binding. Without it every
// Episode cleans up through the Cloudflare closer.
func (e SFUExecutor) WithChalkSFU(episodes EpisodeProviders, chalk ChalkCleanup) SFUExecutor {
	e.episodes = episodes
	e.chalk = chalk
	return e
}

func NewSFUExecutor(publications mediapublications.Registry, tracks TrackCloser, recording ...RecordingController) SFUExecutor {
	var controller RecordingController
	if len(recording) > 0 {
		controller = recording[0]
	}
	return SFUExecutor{publications: publications, tracks: tracks, recording: controller}
}

func (e SFUExecutor) Dispatch(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	return e.execute(ctx, input)
}

func (e SFUExecutor) Reconcile(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	return e.execute(ctx, input)
}

func (e SFUExecutor) execute(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	switch input.Effect {
	case provideroperations.EffectGrantPublication:
		if input.ParticipantGeneration <= 0 {
			return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "participant_generation_required"}
		}
		return e.resumePublication(ctx, input)
	case provideroperations.EffectRevokePublication, provideroperations.EffectRemoveParticipant:
		if input.ParticipantGeneration <= 0 {
			return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "participant_generation_required"}
		}
	case provideroperations.EffectEndEpisode:
	case provideroperations.EffectStartRecording:
		if input.RecordingID.IsZero() {
			return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "recording_id_required"}
		}
		if e.recording == nil {
			return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "recording_controller_unavailable"}
		}
		if err := e.recording.Start(ctx, input); err != nil {
			return recordingExecutionFailure(err)
		}
		return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
	case provideroperations.EffectStopRecording:
		if input.RecordingID.IsZero() {
			return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "recording_id_required"}
		}
		if e.recording == nil {
			return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "recording_controller_unavailable"}
		}
		if err := e.recording.Stop(ctx, input); err != nil {
			return recordingExecutionFailure(err)
		}
		return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
	default:
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "unsupported_effect"}
	}
	if e.publications == nil {
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "executor_unavailable"}
	}
	provider, closer, result := e.bound(ctx, input)
	if result != nil {
		return *result
	}
	if provider == mediaplane.ProviderChalkSFU && input.Effect == provideroperations.EffectEndEpisode {
		ended := mediaplane.EndEpisodeInput{Provider: provider, TenantID: input.TenantID.String(), EpisodeRef: input.EpisodeID.String()}
		if err := e.chalk.EndEpisode(ctx, ended); err != nil {
			return providerExecutionFailure(err)
		}
	}

	snapshot, err := e.publications.Latest(ctx, input.TenantID, input.EpisodeID)
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
	if closer == nil {
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "executor_unavailable"}
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
	allAlreadyClosed := true
	for _, connectionID := range connectionIDs {
		connectionTargets := connections[connectionID]
		tracks := make([]mediaplane.CloseTrack, 0, len(connectionTargets))
		for _, target := range connectionTargets {
			tracks = append(tracks, mediaplane.CloseTrack{Mid: target.reference.MID, Source: target.publication.Source, PublicationID: target.publication.PublicationID})
		}
		closed, err := closer.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: provider, ConnectionID: connectionID, Tracks: tracks, Force: true,
			Scope: mediaplane.Scope{
				TenantID: input.TenantID.String(), EpisodeID: input.EpisodeID.String(),
				ParticipantID: connectionTargets[0].publication.ParticipantID.String(), Generation: connectionTargets[0].reference.ParticipantGeneration,
			},
		})
		if errors.Is(err, mediaplane.ErrConnectionNotFound) {
			closed.AlreadyClosed = true
			err = nil
		}
		if err != nil {
			result := providerExecutionFailure(err)
			slog.WarnContext(ctx, "Provider media cleanup failed", "operation_id", input.OperationID, "effect", input.Effect, "stage", "close_tracks", "error_code", result.Reason)
			return result
		}
		allAlreadyClosed = allAlreadyClosed && closed.AlreadyClosed
		for _, target := range connectionTargets {
			if err := e.publications.RecordClosedPublication(ctx, mediapublications.CloseInput{
				TenantID: input.TenantID, EpisodeID: input.EpisodeID, ParticipantID: target.publication.ParticipantID,
				ParticipantGeneration: target.reference.ParticipantGeneration, ConnectionID: connectionID,
				MID: target.reference.MID, Source: target.publication.Source, PublicationID: target.publication.PublicationID,
			}); err != nil {
				slog.WarnContext(ctx, "Provider media cleanup observation failed", "operation_id", input.OperationID, "effect", input.Effect, "stage", "record_closed_publication", "error_code", "observation_update_failed")
				return ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous, Reason: "observation_update_failed"}
			}
		}
	}
	if allAlreadyClosed {
		return ExecutionResult{Outcome: provideroperations.OutcomeSatisfied}
	}
	return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

// bound picks the closer from the Episode's binding. A provider this build does
// not know ends the operation as a terminal failure; it never falls back to
// Cloudflare, which would close another provider's tracks by the wrong rules.
func (e SFUExecutor) bound(ctx context.Context, input provideroperations.OperationInput) (mediaplane.Provider, TrackCloser, *ExecutionResult) {
	name := string(spaces.MediaPlaneProviderCloudflareSFU)
	if e.episodes != nil {
		found, err := e.episodes.ProviderOf(ctx, input.TenantID, input.EpisodeID)
		if err != nil {
			result := ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "observation_unavailable"}
			return "", nil, &result
		}
		if found != "" {
			name = found
		}
	}
	switch spaces.MediaPlaneProvider(name) {
	case spaces.MediaPlaneProviderCloudflareSFU:
		if e.tracks == nil {
			return mediaplane.ProviderCloudflareSFU, nil, nil
		}
		return mediaplane.ProviderCloudflareSFU, e.tracks, nil
	case spaces.MediaPlaneProviderChalkSFU:
		if e.chalk == nil {
			result := ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "executor_unavailable"}
			return "", nil, &result
		}
		return mediaplane.ProviderChalkSFU, e.chalk, nil
	default:
		result := ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "unsupported_provider"}
		return "", nil, &result
	}
}

func (e SFUExecutor) resumePublication(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	// The browser publishes on a fresh MID after a forced close. There is no
	// previous Cloudflare SFU track to make available again.
	return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

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
		return publication.ParticipantID == input.ParticipantID && (publication.Source == input.PublicationSource || (input.PublicationSource == "screen" && publication.Source == "screen_audio"))
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

package providerbridge

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type SFUExecutor struct {
	publications mediapublications.Registry
	tracks       TrackCloser
	recording    RecordingController
	episodes     EpisodeProviders
	chalk        ChalkNodes
	closeBudget  time.Duration
	// retired ends an Episode on the allocations it moved away from.
	retired func(ctx context.Context, tenantID, episodeID utilities.ID) error
}

// WithRetiredAllocations makes the end of an Episode also clean up the allocations that
// whole-Episode recovery left, which the Episode's current binding no longer names.
func (e SFUExecutor) WithRetiredAllocations(retired func(ctx context.Context, tenantID, episodeID utilities.ID) error) SFUExecutor {
	e.retired = retired
	return e
}

// WithChalkSFU makes grants and cleanup follow the Episode's binding. Without it
// every Episode cleans up through the Cloudflare closer.
func (e SFUExecutor) WithChalkSFU(episodes EpisodeProviders, chalk ChalkNodes) SFUExecutor {
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
	provider, closer, chalk, result := e.bound(ctx, input)
	if result != nil {
		return *result
	}
	if chalk != nil && input.Effect == provideroperations.EffectEndEpisode {
		ended := mediaplane.EndEpisodeInput{Provider: provider, TenantID: input.TenantID.String(), EpisodeRef: input.EpisodeID.String()}
		if err := chalk.EndEpisode(ctx, ended); err != nil {
			return providerExecutionFailure(err)
		}
		if e.retired != nil {
			if err := e.retired(ctx, input.TenantID, input.EpisodeID); err != nil {
				return providerExecutionFailure(err)
			}
		}
	}
	if chalk != nil && input.Effect != provideroperations.EffectEndEpisode && input.ControlRevision > 0 {
		return e.revokeSources(ctx, chalk, input)
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
	budget := e.closeBudget
	if budget == 0 {
		budget = providerCloseBudget
	}
	closeCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	type closeResult struct {
		closed mediaplane.CloseTracksResponse
		err    error
	}
	closeResults := make([]closeResult, len(connectionIDs))
	semaphore := make(chan struct{}, providerCloseFanOut)
	var closeWaitGroup sync.WaitGroup
	for index, connectionID := range connectionIDs {
		connectionTargets := connections[connectionID]
		tracks := make([]mediaplane.CloseTrack, 0, len(connectionTargets))
		for _, target := range connectionTargets {
			tracks = append(tracks, mediaplane.CloseTrack{Mid: target.reference.MID, Source: target.publication.Source, PublicationID: target.publication.PublicationID})
		}
		closeWaitGroup.Add(1)
		go func(index int, connectionID string, connectionTargets []publicationTarget, tracks []mediaplane.CloseTrack) {
			defer closeWaitGroup.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-closeCtx.Done():
				closeResults[index].err = closeCtx.Err()
				return
			}
			if err := closeCtx.Err(); err != nil {
				closeResults[index].err = err
				return
			}
			closed, err := closer.CloseTracks(closeCtx, mediaplane.CloseTracksRequest{
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
			closeResults[index] = closeResult{closed: closed, err: err}
		}(index, connectionID, connectionTargets, tracks)
	}
	closeWaitGroup.Wait()

	allAlreadyClosed := true
	var closeFailures []error
	recordFailed := false
	for index, connectionID := range connectionIDs {
		closeResult := closeResults[index]
		if closeResult.err != nil {
			allAlreadyClosed = false
			closeFailures = append(closeFailures, closeResult.err)
			continue
		}
		allAlreadyClosed = allAlreadyClosed && closeResult.closed.AlreadyClosed
		connectionTargets := connections[connectionID]
		for _, target := range connectionTargets {
			if err := e.publications.RecordClosedPublication(ctx, mediapublications.CloseInput{
				TenantID: input.TenantID, EpisodeID: input.EpisodeID, ParticipantID: target.publication.ParticipantID,
				ParticipantGeneration: target.reference.ParticipantGeneration, ConnectionID: connectionID,
				MID: target.reference.MID, Source: target.publication.Source, PublicationID: target.publication.PublicationID,
			}); err != nil {
				slog.WarnContext(ctx, "Provider media cleanup observation failed", "operation_id", input.OperationID, "effect", input.Effect, "stage", "record_closed_publication", "error_code", "observation_update_failed")
				recordFailed = true
			}
		}
	}
	if recordFailed {
		return ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous, Reason: "observation_update_failed"}
	}
	budgetExpired := closeCtx.Err() == context.DeadlineExceeded && ctx.Err() == nil
	var firstNonBudgetFailure error
	budgetFailure := false
	for _, err := range closeFailures {
		if budgetExpired && (errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)) {
			budgetFailure = true
			continue
		}
		if firstNonBudgetFailure == nil {
			firstNonBudgetFailure = err
		}
	}
	if firstNonBudgetFailure != nil {
		result := providerExecutionFailure(firstNonBudgetFailure)
		slog.WarnContext(ctx, "Provider media cleanup failed", "operation_id", input.OperationID, "effect", input.Effect, "stage", "close_tracks", "error_code", result.Reason)
		return result
	}
	if budgetFailure {
		slog.WarnContext(ctx, "Provider media cleanup failed", "operation_id", input.OperationID, "effect", input.Effect, "stage", "close_tracks", "error_code", "timeout")
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "timeout"}
	}
	if allAlreadyClosed {
		return ExecutionResult{Outcome: provideroperations.OutcomeSatisfied}
	}
	return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

package providerbridge

import (
	"context"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

// revokeSources fences the sources on the own SFU, which stops forwarding and closes
// the publications admitted before the revoke. A track a newer grant admitted stays
// open, so the executor records as closed only the tracks the node reports and never
// follows the revoke with a close of its own. A record a lost response leaves open is
// settled by remote track reconciliation.
func (e *SFUExecutor) revokeSources(ctx context.Context, chalk ChalkNode, input provideroperations.OperationInput) ExecutionResult {
	applied, closed, result := controlSources(ctx, chalk, input, mediaplane.SourceRevoke)
	if result != nil {
		return *result
	}
	if len(applied) == 0 {
		// A newer grant superseded this revoke. Its publication is not ours to close.
		return ExecutionResult{Outcome: provideroperations.OutcomeSatisfied}
	}
	if len(closed) == 0 {
		return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
	}
	snapshot, err := e.publications.Latest(ctx, input.TenantID, input.EpisodeID)
	if err != nil {
		return ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "observation_unavailable"}
	}
	targets, failed := operationTargets(snapshot.Publications, input)
	if failed != nil {
		return *failed
	}
	for _, target := range targets {
		if !closed[mediaplane.ClosedSourceTrack{ConnectionID: target.reference.ConnectionID, MID: target.reference.MID}] {
			continue
		}
		if err := e.publications.RecordClosedPublication(ctx, mediapublications.CloseInput{
			TenantID: input.TenantID, EpisodeID: input.EpisodeID, ParticipantID: target.publication.ParticipantID,
			ParticipantGeneration: target.reference.ParticipantGeneration, ConnectionID: target.reference.ConnectionID,
			MID: target.reference.MID, Source: target.publication.Source, PublicationID: target.publication.PublicationID,
		}); err != nil {
			slog.WarnContext(ctx, "Provider media cleanup observation failed", "operation_id", input.OperationID, "effect", input.Effect, "stage", "record_closed_publication", "error_code", "observation_update_failed")
			return ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous, Reason: "observation_update_failed"}
		}
	}
	return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

// bound picks the closer from the Episode's binding, and for the own SFU the
// node the binding names. A provider this build does not know ends the operation
// as a terminal failure; it never falls back to Cloudflare, which would close
// another provider's tracks by the wrong rules.
func (e SFUExecutor) bound(ctx context.Context, input provideroperations.OperationInput) (mediaplane.Provider, TrackCloser, ChalkNode, *ExecutionResult) {
	name, node, generation := mediaplane.ProviderCloudflareSFU.SettingName(), "", int64(0)
	if e.episodes != nil {
		found, foundNode, foundGeneration, err := e.episodes.BindingOf(ctx, input.TenantID, input.EpisodeID)
		if err != nil {
			result := ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "observation_unavailable"}
			return "", nil, nil, &result
		}
		if found != "" {
			name, node, generation = found, foundNode, foundGeneration
		}
	}
	provider, _ := mediaplane.ParseSettingName(name)
	switch provider {
	case mediaplane.ProviderCloudflareSFU:
		if e.tracks == nil {
			return mediaplane.ProviderCloudflareSFU, nil, nil, nil
		}
		return mediaplane.ProviderCloudflareSFU, e.tracks, nil, nil
	case mediaplane.ProviderChalkSFU:
		unavailable := ExecutionResult{Outcome: provideroperations.OutcomeRetryableFailure, Reason: "executor_unavailable"}
		if e.chalk == nil {
			return "", nil, nil, &unavailable
		}
		// A node missing from this process's configuration may come back with the
		// next deploy, so the operation retries instead of failing for good.
		chalk, err := e.chalk(node, generation)
		if err != nil {
			return "", nil, nil, &unavailable
		}
		return mediaplane.ProviderChalkSFU, chalk, chalk, nil
	default:
		result := ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "unsupported_provider"}
		return "", nil, nil, &result
	}
}

// resumePublication grants the source on the own SFU, which forwards a source only
// under a grant. Cloudflare needs nothing: the browser publishes on a fresh MID
// after a forced close, so no previous track is made available again.
func (e SFUExecutor) resumePublication(ctx context.Context, input provideroperations.OperationInput) ExecutionResult {
	if e.episodes == nil {
		return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
	}
	_, _, chalk, result := e.bound(ctx, input)
	if result != nil {
		return *result
	}
	if chalk == nil {
		return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
	}
	if input.ControlRevision <= 0 {
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "control_revision_required"}
	}
	applied, _, result := controlSources(ctx, chalk, input, mediaplane.SourceGrant)
	if result != nil {
		return *result
	}
	if len(applied) == 0 {
		// A newer revoke holds the source. Reporting the grant as done would show
		// a publication the node will never forward.
		return ExecutionResult{Outcome: provideroperations.OutcomeTerminalFailure, Reason: "source_revoked"}
	}
	return ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

// controlSources sends one action for every source the operation names at its
// control revision, and returns the sources the node applied it to.
func controlSources(ctx context.Context, chalk ChalkNode, input provideroperations.OperationInput, action mediaplane.SourceAction) (map[mediaplane.PublicationSource]bool, map[mediaplane.ClosedSourceTrack]bool, *ExecutionResult) {
	sources := []mediaplane.PublicationSource{input.PublicationSource}
	if input.Effect == provideroperations.EffectRemoveParticipant {
		sources = mediaplane.SelectableSources
	}
	controls := make([]mediaplane.SourceControl, 0, len(sources)+1)
	for _, source := range sources {
		controls = append(controls, mediaplane.SourceControl{ParticipantID: input.ParticipantID.String(), Source: source, Action: action, Revision: input.ControlRevision})
		// Tab audio is published with the screen and follows its control.
		if companion, ok := source.Companion(); ok {
			controls = append(controls, mediaplane.SourceControl{ParticipantID: input.ParticipantID.String(), Source: companion, Action: action, Revision: input.ControlRevision})
		}
	}
	results, err := chalk.ControlSources(ctx, mediaplane.ControlSourcesInput{TenantID: input.TenantID.String(), EpisodeID: input.EpisodeID.String(), Controls: controls})
	if err != nil {
		result := providerExecutionFailure(err)
		slog.WarnContext(ctx, "Provider source control failed", "operation_id", input.OperationID, "effect", input.Effect, "action", action, "error_code", result.Reason)
		return nil, nil, &result
	}
	applied, closed := map[mediaplane.PublicationSource]bool{}, map[mediaplane.ClosedSourceTrack]bool{}
	for _, result := range results {
		if result.Applied {
			applied[result.Source] = true
		}
		for _, track := range result.Closed {
			closed[track] = true
		}
	}
	return applied, closed, nil
}

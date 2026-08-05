package traceharness

import (
	"context"
	"fmt"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func runAdapterProviderBridgeGrant(ctx context.Context) (ScenarioResult, error) {
	recorder := NewRecorder(deterministicClock())
	publications := &tracedMediaPublicationRegistry{recorder: recorder}
	tracks := &tracedProviderBridgeTrackCloser{recorder: recorder}
	executor := providerbridge.NewSFUExecutor(publications, tracks)
	input := provideroperations.OperationInput{
		OperationID:           "trace-publication-grant",
		Effect:                provideroperations.EffectGrantPublication,
		TenantID:              tenantID(),
		EpisodeID:             episodeID(),
		ParticipantID:         participantID(),
		ParticipantGeneration: 1,
		PublicationSource:     "camera",
	}

	span := recorder.Start(
		"service",
		"providerbridge.SFUExecutor.Dispatch",
		"authorize browser-owned publication without calling the provider",
		map[string]any{
			"effect":                 input.Effect,
			"participant_generation": input.ParticipantGeneration,
			"publication_source":     input.PublicationSource,
		},
	)
	result := executor.Dispatch(ctx, input)
	span.End(
		"provider bridge returned publication authorization",
		map[string]any{"outcome": result.Outcome, "reason": result.Reason},
		nil,
	)

	var scenarioErr error
	if result.Outcome != provideroperations.OutcomeConfirmed {
		scenarioErr = fmt.Errorf("publication grant outcome = %q, want %q", result.Outcome, provideroperations.OutcomeConfirmed)
	} else if tracks.calls != 0 {
		scenarioErr = fmt.Errorf("publication grant made %d provider track calls, want 0", tracks.calls)
	}

	return directResult(
		AdapterProviderBridgeGrantScenario,
		http.StatusOK,
		recorder,
		map[string]any{"effect": input.Effect, "outcome": result.Outcome},
		scenarioErr,
	)
}

type tracedProviderBridgeTrackCloser struct {
	recorder *Recorder
	calls    int
}

func (t *tracedProviderBridgeTrackCloser) CloseTracks(
	context.Context,
	mediaplane.CloseTracksRequest,
) (mediaplane.CloseTracksResponse, error) {
	t.calls++
	t.recorder.Add(
		"provider",
		"cloudflare.sfu.Adapter.CloseTracks",
		"unexpected provider mutation for browser-owned publication grant",
		nil,
	)
	return mediaplane.CloseTracksResponse{}, fmt.Errorf("unexpected provider track close")
}

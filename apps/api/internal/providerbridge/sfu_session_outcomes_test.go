package providerbridge

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type chalkBinding struct{}

func (chalkBinding) BindingOf(context.Context, utilities.ID, utilities.ID) (string, string, int64, error) {
	return mediaplane.ProviderChalkSFU.SettingName(), "node-1", 1, nil
}

// endingNode answers an Episode end with the outcomes the media node would report.
type endingNode struct {
	ChalkNode
	outcomes []mediaplane.SessionOutcome
	err      error
}

func (n endingNode) EndEpisodeSessions(context.Context, mediaplane.EndEpisodeInput) ([]mediaplane.SessionOutcome, error) {
	return n.outcomes, n.err
}

type recordedOutcomes struct {
	tenant, episode utilities.ID
	outcomes        []mediaplane.SessionOutcome
	err             error
}

func (r *recordedOutcomes) Record(_ context.Context, tenantID, episodeID utilities.ID, outcomes []mediaplane.SessionOutcome) error {
	r.tenant, r.episode, r.outcomes = tenantID, episodeID, append(r.outcomes, outcomes...)
	return r.err
}

func endExecutor(t *testing.T, node endingNode, recorder *recordedOutcomes) SFUExecutor {
	t.Helper()
	registry, _, _ := newMultiExecutorPublicationRegistry(t, 0)
	executor := NewSFUExecutor(registry, nil).WithChalkSFU(chalkBinding{}, func(string, int64) (ChalkNode, error) { return node, nil })
	if recorder != nil {
		executor = executor.WithSessionOutcomes(recorder)
	}
	return executor
}

// How the node's sessions ended is saved before the end of the Episode is confirmed.
func TestEndEpisodeSavesHowTheNodesSessionsEnded(t *testing.T) {
	ended := []mediaplane.SessionOutcome{
		{ConnectionID: "node.one", ParticipantRef: "33333333-3333-4333-8333-333333333333", ParticipantVersion: 1, Cause: "peer_closed", Outcome: "left", Connected: true, EndedAt: time.Now(), LifetimeMs: 9000, ConnectMs: 400},
		{ConnectionID: "node.two", ParticipantRef: "44444444-4444-4444-8444-444444444444", ParticipantVersion: 2, Cause: "episode_ended", Outcome: "never_connected", EndedAt: time.Now()},
	}
	recorder := &recordedOutcomes{}
	input := testEndOperation(t)

	result := endExecutor(t, endingNode{outcomes: ended}, recorder).Dispatch(t.Context(), input)

	if result.Outcome != provideroperations.OutcomeSatisfied && result.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("end = %+v, want the end to complete", result)
	}
	if len(recorder.outcomes) != 2 || recorder.tenant != input.TenantID || recorder.episode != input.EpisodeID {
		t.Fatalf("recorded %d outcomes for %v/%v, want 2 for the Episode", len(recorder.outcomes), recorder.tenant, recorder.episode)
	}
	if recorder.outcomes[1].Outcome != "never_connected" || recorder.outcomes[0].ConnectionID != "node.one" {
		t.Fatalf("recorded = %+v", recorder.outcomes)
	}
}

// An outcome that cannot be saved holds the end, so the retry asks the node again; the node keeps
// its outcomes for that.
func TestEndEpisodeRetriesWhenTheOutcomesCannotBeSaved(t *testing.T) {
	recorder := &recordedOutcomes{err: errors.New("database unavailable")}
	node := endingNode{outcomes: []mediaplane.SessionOutcome{{ConnectionID: "node.one", ParticipantRef: "33333333-3333-4333-8333-333333333333", ParticipantVersion: 1}}}

	result := endExecutor(t, node, recorder).Dispatch(t.Context(), testEndOperation(t))

	if result.Outcome != provideroperations.OutcomeRetryableFailure || result.Reason != "provider_unavailable" {
		t.Fatalf("end = %+v, want a retryable failure", result)
	}
}

func TestEndEpisodeWithNoOutcomesSavesNothing(t *testing.T) {
	recorder := &recordedOutcomes{err: errors.New("must not be called")}
	result := endExecutor(t, endingNode{}, recorder).Dispatch(t.Context(), testEndOperation(t))
	if result.Outcome == provideroperations.OutcomeRetryableFailure {
		t.Fatalf("end = %+v, want it to complete without saving", result)
	}
}

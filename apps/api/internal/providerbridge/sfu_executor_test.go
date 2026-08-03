package providerbridge

import (
	"context"
	"encoding/base64"
	"strconv"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSFUExecutorRevokesExactPublicationAndReconcilesIdempotently(t *testing.T) {
	participantID := mustID(t, "33333333-3333-4333-8333-333333333333")
	registry := &publicationRegistryStub{snapshot: mediapublications.Snapshot{Publications: []provideroperations.Publication{{
		ParticipantID: participantID, Source: "camera", Enabled: true,
		PublicationID: publicationReference("connection-1", "mid-1", "camera-track", 7),
	}}}}
	closer := &trackCloserStub{}
	executor := NewSFUExecutor(registry, closer)
	input := provideroperations.OperationInput{
		Effect: provideroperations.EffectRevokePublication, TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID: mustID(t, "22222222-2222-4222-8222-222222222222"), ParticipantID: participantID,
		ParticipantGeneration: 7, PublicationSource: "camera",
	}

	result := executor.Dispatch(context.Background(), input)
	if result.Outcome != provideroperations.OutcomeConfirmed || len(closer.inputs) != 1 || len(registry.closed) != 1 {
		t.Fatalf("dispatch result = %#v close inputs = %#v registry closes = %#v", result, closer.inputs, registry.closed)
	}
	closed := closer.inputs[0]
	if closed.ConnectionID != "connection-1" || len(closed.Tracks) != 1 || closed.Tracks[0].Mid != "mid-1" || closed.Tracks[0].PublicationID != registry.closed[0].PublicationID {
		t.Fatalf("closed tracks = %#v", closed)
	}

	result = executor.Reconcile(context.Background(), input)
	if result.Outcome != provideroperations.OutcomeSatisfied || len(closer.inputs) != 1 {
		t.Fatalf("reconcile result = %#v close calls = %d", result, len(closer.inputs))
	}
}

func TestSFUExecutorPreservesNewParticipantGeneration(t *testing.T) {
	participantID := mustID(t, "33333333-3333-4333-8333-333333333333")
	registry := &publicationRegistryStub{snapshot: mediapublications.Snapshot{Publications: []provideroperations.Publication{{
		ParticipantID: participantID, Source: "microphone", Enabled: true,
		PublicationID: publicationReference("connection-new", "mid-new", "microphone-track", 8),
	}}}}
	closer := &trackCloserStub{}
	executor := NewSFUExecutor(registry, closer)
	result := executor.Dispatch(context.Background(), provideroperations.OperationInput{
		Effect: provideroperations.EffectRemoveParticipant, TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID: mustID(t, "22222222-2222-4222-8222-222222222222"), ParticipantID: participantID,
		ParticipantGeneration: 7,
	})

	if result.Outcome != provideroperations.OutcomeSatisfied || len(closer.inputs) != 0 {
		t.Fatalf("stale generation result = %#v close calls = %d", result, len(closer.inputs))
	}
}

func TestSFUExecutorAuthorizesClientOwnedPublicationGrant(t *testing.T) {
	registry := &publicationRegistryStub{}
	closer := &trackCloserStub{}
	executor := NewSFUExecutor(registry, closer)
	input := provideroperations.OperationInput{
		Effect: provideroperations.EffectGrantPublication, TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID:             mustID(t, "22222222-2222-4222-8222-222222222222"),
		ParticipantID:         mustID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantGeneration: 1, PublicationSource: "camera",
	}

	result := executor.Dispatch(context.Background(), input)
	if result.Outcome != provideroperations.OutcomeConfirmed || result.Reason != "" {
		t.Fatalf("grant result = %#v", result)
	}
	if registry.latestCalls != 0 || len(registry.closed) != 0 || len(closer.inputs) != 0 {
		t.Fatalf("grant touched media state: latest calls = %d closes = %#v tracks = %#v", registry.latestCalls, registry.closed, closer.inputs)
	}

	input.ParticipantGeneration = 0
	result = executor.Dispatch(context.Background(), input)
	if result.Outcome != provideroperations.OutcomeTerminalFailure || result.Reason != "participant_generation_required" {
		t.Fatalf("grant without generation result = %#v", result)
	}
	if registry.latestCalls != 0 || len(registry.closed) != 0 || len(closer.inputs) != 0 {
		t.Fatalf("invalid grant touched media state: latest calls = %d closes = %#v tracks = %#v", registry.latestCalls, registry.closed, closer.inputs)
	}
}

func TestSFUExecutorEndsEpisodeAcrossConnections(t *testing.T) {
	firstParticipant := mustID(t, "33333333-3333-4333-8333-333333333333")
	secondParticipant := mustID(t, "44444444-4444-4444-8444-444444444444")
	registry := &publicationRegistryStub{snapshot: mediapublications.Snapshot{Publications: []provideroperations.Publication{
		{ParticipantID: firstParticipant, Source: "camera", Enabled: true, PublicationID: publicationReference("connection-a", "0", "camera", 1)},
		{ParticipantID: secondParticipant, Source: "screen", Enabled: true, PublicationID: publicationReference("connection-b", "1", "screen", 2)},
	}}}
	closer := &trackCloserStub{}
	result := NewSFUExecutor(registry, closer).Dispatch(context.Background(), provideroperations.OperationInput{
		Effect: provideroperations.EffectEndEpisode, TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID: mustID(t, "22222222-2222-4222-8222-222222222222"),
	})

	if result.Outcome != provideroperations.OutcomeConfirmed || len(closer.inputs) != 2 || len(registry.closed) != 2 {
		t.Fatalf("end result = %#v close inputs = %#v closes = %#v", result, closer.inputs, registry.closed)
	}
}

func TestSFUExecutorFailsLegacyAndUnsupportedEffectsExplicitly(t *testing.T) {
	participantID := mustID(t, "33333333-3333-4333-8333-333333333333")
	registry := &publicationRegistryStub{snapshot: mediapublications.Snapshot{Publications: []provideroperations.Publication{{
		ParticipantID: participantID, Source: "camera", Enabled: true, PublicationID: "connection-1|camera-track",
	}}}}
	executor := NewSFUExecutor(registry, &trackCloserStub{})
	legacy := executor.Dispatch(context.Background(), provideroperations.OperationInput{
		Effect: provideroperations.EffectRemoveParticipant, TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID: mustID(t, "22222222-2222-4222-8222-222222222222"), ParticipantID: participantID,
		ParticipantGeneration: 1,
	})
	if legacy.Outcome != provideroperations.OutcomeTerminalFailure || legacy.Reason != "legacy_publication_reference" {
		t.Fatalf("legacy result = %#v", legacy)
	}
	unsupported := executor.Dispatch(context.Background(), provideroperations.OperationInput{Effect: provideroperations.EffectStartRecording})
	if unsupported.Outcome != provideroperations.OutcomeTerminalFailure || unsupported.Reason != "unsupported_effect" {
		t.Fatalf("unsupported result = %#v", unsupported)
	}
}

func TestSFUExecutorKeepsAmbiguousProviderResultForReconciliation(t *testing.T) {
	participantID := mustID(t, "33333333-3333-4333-8333-333333333333")
	registry := &publicationRegistryStub{snapshot: mediapublications.Snapshot{Publications: []provideroperations.Publication{{
		ParticipantID: participantID, Source: "camera", Enabled: true,
		PublicationID: publicationReference("connection-1", "0", "camera", 1),
	}}}}
	closer := &trackCloserStub{err: mediaplane.ErrProviderFailed}
	result := NewSFUExecutor(registry, closer).Dispatch(context.Background(), provideroperations.OperationInput{
		Effect: provideroperations.EffectRemoveParticipant, TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"),
		EpisodeID: mustID(t, "22222222-2222-4222-8222-222222222222"), ParticipantID: participantID,
		ParticipantGeneration: 1,
	})
	if result.Outcome != provideroperations.OutcomeAmbiguous || result.Reason != "provider_result_ambiguous" || len(registry.closed) != 0 {
		t.Fatalf("ambiguous result = %#v closes = %#v", result, registry.closed)
	}
}

type publicationRegistryStub struct {
	snapshot    mediapublications.Snapshot
	latestErr   error
	latestCalls int
	closeErr    error
	closed      []mediapublications.CloseInput
}

func (*publicationRegistryStub) RecordPublishedTracks(context.Context, mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	return nil, nil
}

func (*publicationRegistryStub) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	return mediapublications.CloseDecision{ProviderCloseRequired: true}, nil
}

func (r *publicationRegistryStub) RecordClosedPublication(_ context.Context, input mediapublications.CloseInput) error {
	if r.closeErr != nil {
		return r.closeErr
	}
	r.closed = append(r.closed, input)
	for index := range r.snapshot.Publications {
		publication := &r.snapshot.Publications[index]
		if publication.ParticipantID == input.ParticipantID && publication.Source == input.Source && publication.PublicationID == input.PublicationID {
			publication.Enabled = false
			publication.PublicationID = ""
		}
	}
	return nil
}

func (r *publicationRegistryStub) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	r.latestCalls++
	return r.snapshot, r.latestErr
}

type trackCloserStub struct {
	inputs []mediaplane.CloseTracksRequest
	err    error
}

func (c *trackCloserStub) CloseTracks(_ context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	c.inputs = append(c.inputs, input)
	return mediaplane.CloseTracksResponse{}, c.err
}

func publicationReference(connectionID, mid, trackName string, generation int64) string {
	payload := `{"c":"` + connectionID + `","m":"` + mid + `","t":"` + trackName + `","g":` + strconv.FormatInt(generation, 10) + `}`
	return "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(payload))
}

var _ mediapublications.Registry = (*publicationRegistryStub)(nil)
var _ TrackCloser = (*trackCloserStub)(nil)

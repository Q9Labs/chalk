package providerbridge

import (
	"context"
	"encoding/base64"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestForcedMuteClosesCloudflareTrack(t *testing.T) {
	ctx := context.Background()
	tenantID := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"publisher-connection","m":"0","t":"microphone-track","g":1}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID}}
	closer := &executorTrackCloser{}
	executor := NewSFUExecutor(registry, closer)
	operation := provideroperations.OperationInput{Effect: provideroperations.EffectRevokePublication, TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, PublicationSource: "microphone"}

	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("forced mute outcome = %+v", result)
	}
	if registry.publication.Enabled || registry.publication.PublicationID != "" || closer.calls != 1 || !closer.force {
		t.Fatalf("forced mute did not close Cloudflare SFU track: publication=%+v closes=%d", registry.publication, closer.calls)
	}

	operation.Effect = provideroperations.EffectGrantPublication
	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeConfirmed {
		t.Fatalf("re-enable outcome = %+v", result)
	}
	if registry.publication.PublicationID != "" || closer.calls != 1 {
		t.Fatalf("re-enable restored a closed Cloudflare SFU track: publication=%+v closes=%d", registry.publication, closer.calls)
	}

	operation.Effect = provideroperations.EffectRevokePublication
	_ = executor.Dispatch(ctx, operation)
	operation.Effect = provideroperations.EffectRemoveParticipant
	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeSatisfied {
		t.Fatalf("removal outcome = %+v", result)
	}
	if closer.calls != 1 || registry.publication.PublicationID != "" {
		t.Fatalf("closed track was closed again: publication=%+v closes=%d", registry.publication, closer.calls)
	}
	registry.publication.PublicationID = publicationID
	operation.Effect = provideroperations.EffectRevokePublication
	if result := executor.Dispatch(ctx, operation); result.Outcome != provideroperations.OutcomeConfirmed || closer.calls != 2 {
		t.Fatalf("paused track was not force-closed: outcome=%+v closes=%d", result, closer.calls)
	}
}

type executorPublicationRegistry struct {
	publication provideroperations.Publication
}

func (*executorPublicationRegistry) RecordPublishedTracks(context.Context, mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	return nil, nil
}

func (*executorPublicationRegistry) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	return mediapublications.CloseDecision{}, nil
}

func (r *executorPublicationRegistry) RecordClosedPublication(_ context.Context, _ mediapublications.CloseInput) error {
	r.publication.Enabled = false
	r.publication.PublicationID = ""
	return nil
}

func (r *executorPublicationRegistry) RecordPublicationAvailability(_ context.Context, input mediapublications.AvailabilityInput) error {
	if r.publication.PublicationID == input.PublicationID {
		r.publication.Enabled = input.Enabled
	}
	return nil
}

func (r *executorPublicationRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	return mediapublications.Snapshot{Publications: []provideroperations.Publication{r.publication}}, nil
}

type executorTrackCloser struct {
	calls int
	force bool
	err   error
}

func (c *executorTrackCloser) CloseTracks(_ context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	c.calls++
	c.force = input.Force
	return mediaplane.CloseTracksResponse{}, c.err
}

func testExecutorID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatalf("parse ID: %v", err)
	}
	return id
}

func TestStaleConnectionEndReconcilesDispatchingReceipt(t *testing.T) {
	input := testEndOperation(t)
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"stale-connection","m":"0","t":"microphone-track","g":1}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID}}
	client := &executorTrackCloser{err: mediaplane.ErrConnectionNotFound}
	repository := &failureReceiptRepository{}
	_, _ = repository.Prepare(context.Background(), input)
	_, _ = repository.MarkDispatching(context.Background(), input.OperationID, input.Effect)
	service := NewService(repository, NewSFUExecutor(registry, client))
	result, err := service.Execute(context.Background(), input)
	if err != nil || result.Outcome != provideroperations.OutcomeSatisfied || registry.publication.PublicationID != "" || repository.receipt.State != provideroperations.ReceiptCompleted {
		t.Fatalf("stale end = %+v, %v, receipt=%+v", result, err, repository.receipt)
	}
	_, err = service.Execute(context.Background(), input)
	if err != nil || client.calls != 1 {
		t.Fatalf("completed replay sent another close: calls=%d err=%v", client.calls, err)
	}
}

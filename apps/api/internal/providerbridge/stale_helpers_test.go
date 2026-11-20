package providerbridge

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func testEndOperation(t *testing.T) provideroperations.OperationInput {
	t.Helper()
	return provideroperations.OperationInput{OperationID: "episode-end-operation-0001", Effect: provideroperations.EffectEndEpisode, TenantID: testExecutorID(t, "11111111-1111-4111-8111-111111111111"), EpisodeID: testExecutorID(t, "22222222-2222-4222-8222-222222222222")}
}

type failureReceiptRepository struct {
	provideroperations.Repository
	receipt provideroperations.Receipt
}

func (r *failureReceiptRepository) Prepare(_ context.Context, input provideroperations.OperationInput) (provideroperations.PrepareResult, error) {
	if r.receipt.OperationID == "" {
		canonical, err := input.Canonicalize()
		if err != nil {
			return provideroperations.PrepareResult{}, err
		}
		r.receipt = provideroperations.Receipt{OperationID: input.OperationID, Effect: input.Effect, TenantID: input.TenantID, EpisodeID: input.EpisodeID, Payload: canonical.Payload, Fingerprint: canonical.Fingerprint, State: provideroperations.ReceiptPrepared}
	}
	return provideroperations.PrepareResult{Receipt: r.receipt}, nil
}
func (r *failureReceiptRepository) MarkDispatching(context.Context, string, provideroperations.Effect) (provideroperations.Receipt, error) {
	r.receipt.State = provideroperations.ReceiptDispatching
	return r.receipt, nil
}
func (r *failureReceiptRepository) ResetForRetry(context.Context, string, provideroperations.Effect) (provideroperations.Receipt, error) {
	r.receipt.State = provideroperations.ReceiptPrepared
	return r.receipt, nil
}
func (r *failureReceiptRepository) RecordFailure(ctx context.Context, _ string, _ provideroperations.Effect, reason string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.receipt.Reason = &reason
	r.receipt.LastErrorCode = &reason
	return nil
}
func (r *failureReceiptRepository) Complete(_ context.Context, _ string, _ provideroperations.Effect, completion provideroperations.Completion) (provideroperations.Receipt, error) {
	r.receipt.State = provideroperations.ReceiptCompleted
	r.receipt.Outcome = &completion.Outcome
	r.receipt.Reason = completion.Reason
	r.receipt.LastErrorCode = nil
	return r.receipt, nil
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

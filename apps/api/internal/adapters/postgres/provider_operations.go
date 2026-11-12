package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type providerOperationTransactor interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type ProviderOperationRepository struct {
	queries    providerOperationQuerier
	transactor providerOperationTransactor
}

func NewProviderOperationRepository(queries providerOperationQuerier, transactor providerOperationTransactor) ProviderOperationRepository {
	return ProviderOperationRepository{queries: queries, transactor: transactor}
}

func NewProviderOperationRepositoryWithPool(pool *pgxpool.Pool) ProviderOperationRepository {
	return NewProviderOperationRepository(newProviderOperationQueries(pool), pool)
}

func (r ProviderOperationRepository) Prepare(ctx context.Context, input provideroperations.OperationInput) (provideroperations.PrepareResult, error) {
	canonical, err := provideroperations.Canonicalize(input)
	if err != nil {
		return provideroperations.PrepareResult{}, err
	}
	row, err := r.queries.InsertProviderOperationReceipt(ctx, insertProviderOperationReceiptParams{
		OperationID:           canonical.Input.OperationID,
		Effect:                string(canonical.Input.Effect),
		TenantID:              uuid(canonical.Input.TenantID),
		EpisodeID:             uuid(canonical.Input.EpisodeID),
		ParticipantID:         uuid(canonical.Input.ParticipantID),
		ParticipantGeneration: providerOptionalInt8(canonical.Input.ParticipantGeneration),
		PublicationSource:     providerText(canonical.Input.PublicationSource),
		RecordingID:           uuid(canonical.Input.RecordingID),
		RequestFingerprint:    canonical.Fingerprint[:],
		RequestPayload:        []byte(canonical.Payload),
	})
	if err == nil {
		return provideroperations.PrepareResult{Receipt: mapProviderOperationReceipt(row)}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return provideroperations.PrepareResult{}, fmt.Errorf("insert provider operation receipt: %w", err)
	}
	existing, err := r.Get(ctx, canonical.Input.OperationID, canonical.Input.Effect)
	if err != nil {
		return provideroperations.PrepareResult{}, err
	}
	if !bytes.Equal(existing.Fingerprint[:], canonical.Fingerprint[:]) {
		return provideroperations.PrepareResult{Receipt: existing}, provideroperations.ErrFingerprintConflict
	}
	return provideroperations.PrepareResult{Receipt: existing, Replay: true}, nil
}

func (r ProviderOperationRepository) MarkDispatching(ctx context.Context, operationID string, effect provideroperations.Effect) (provideroperations.Receipt, error) {
	if err := provideroperations.ValidateIdentity(operationID, effect); err != nil {
		return provideroperations.Receipt{}, err
	}
	row, err := r.queries.MarkProviderOperationDispatching(ctx, providerOperationIdentityParams{OperationID: operationID, Effect: string(effect)})
	if err == nil {
		return mapProviderOperationReceipt(row), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return provideroperations.Receipt{}, fmt.Errorf("mark provider operation dispatching: %w", err)
	}
	return r.resolveTransition(ctx, operationID, effect, false)
}

func (r ProviderOperationRepository) ResetForRetry(ctx context.Context, operationID string, effect provideroperations.Effect) (provideroperations.Receipt, error) {
	if err := provideroperations.ValidateIdentity(operationID, effect); err != nil {
		return provideroperations.Receipt{}, err
	}
	row, err := r.queries.ResetProviderOperationForRetry(ctx, providerOperationIdentityParams{OperationID: operationID, Effect: string(effect)})
	if err == nil {
		return mapProviderOperationReceipt(row), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return provideroperations.Receipt{}, fmt.Errorf("reset provider operation for retry: %w", err)
	}
	return r.resolveTransition(ctx, operationID, effect, true)
}

func (r ProviderOperationRepository) RecordFailure(ctx context.Context, operationID string, effect provideroperations.Effect, reason string) error {
	if err := provideroperations.ValidateIdentity(operationID, effect); err != nil {
		return err
	}
	if len(reason) == 0 || len(reason) > 64 {
		return provideroperations.ErrInvalidReason
	}
	_, err := r.queries.RecordProviderOperationFailure(ctx, operationID, effect, reason)
	return err
}

func (r ProviderOperationRepository) Complete(ctx context.Context, operationID string, effect provideroperations.Effect, completion provideroperations.Completion) (provideroperations.Receipt, error) {
	if err := provideroperations.ValidateIdentity(operationID, effect); err != nil {
		return provideroperations.Receipt{}, err
	}
	if err := completion.Validate(); err != nil {
		return provideroperations.Receipt{}, err
	}
	params := completeProviderOperationParams{OperationID: operationID, Effect: string(effect), Outcome: providerText(string(completion.Outcome)), Reason: providerTextPointer(completion.Reason)}
	row, err := r.queries.CompleteProviderOperation(ctx, params)
	if err == nil {
		return mapProviderOperationReceipt(row), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return provideroperations.Receipt{}, fmt.Errorf("complete provider operation: %w", err)
	}
	existing, getErr := r.Get(ctx, operationID, effect)
	if getErr != nil {
		return provideroperations.Receipt{}, getErr
	}
	if existing.State != provideroperations.ReceiptCompleted {
		return provideroperations.Receipt{}, provideroperations.ErrInvalidReceiptState
	}
	if existing.Outcome == nil || *existing.Outcome != completion.Outcome || !sameReason(existing.Reason, completion.Reason) {
		return provideroperations.Receipt{}, provideroperations.ErrReceiptConflict
	}
	return existing, nil
}

func (r ProviderOperationRepository) Get(ctx context.Context, operationID string, effect provideroperations.Effect) (provideroperations.Receipt, error) {
	if err := provideroperations.ValidateIdentity(operationID, effect); err != nil {
		return provideroperations.Receipt{}, err
	}
	row, err := r.queries.GetProviderOperationReceipt(ctx, getProviderOperationReceiptParams{OperationID: operationID, Effect: string(effect)})
	if errors.Is(err, pgx.ErrNoRows) {
		return provideroperations.Receipt{}, provideroperations.ErrReceiptNotFound
	}
	if err != nil {
		return provideroperations.Receipt{}, fmt.Errorf("get provider operation receipt: %w", err)
	}
	return mapProviderOperationReceipt(row), nil
}

func (r ProviderOperationRepository) resolveTransition(ctx context.Context, operationID string, effect provideroperations.Effect, retry bool) (provideroperations.Receipt, error) {
	existing, err := r.Get(ctx, operationID, effect)
	if err != nil {
		return provideroperations.Receipt{}, err
	}
	if retry && existing.State == provideroperations.ReceiptPrepared {
		return existing, nil
	}
	if !retry && existing.State != provideroperations.ReceiptPrepared {
		return existing, nil
	}
	return provideroperations.Receipt{}, provideroperations.ErrInvalidReceiptState
}

func (r ProviderOperationRepository) transaction(ctx context.Context, work func(providerOperationQuerier) error) error {
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin provider operation transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := work(newProviderOperationQueries(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit provider operation transaction: %w", err)
	}
	return nil
}

func mapProviderOperationReceipt(row providerOperationReceiptRow) provideroperations.Receipt {
	var fingerprint [32]byte
	copy(fingerprint[:], row.RequestFingerprint)
	return provideroperations.Receipt{
		OperationID: row.OperationID, Effect: provideroperations.Effect(row.Effect), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes),
		ParticipantID: nullableID(row.ParticipantID), ParticipantGeneration: providerNullableInt64(row.ParticipantGeneration), PublicationSource: providerNullableTextValue(row.PublicationSource), RecordingID: nullableID(row.RecordingID),
		Fingerprint: fingerprint, Payload: jsonRaw(row.RequestPayload), State: provideroperations.ReceiptState(row.State), Outcome: nullableOutcome(row.Outcome), Reason: providerNullableTextPointer(row.Reason), LastErrorCode: providerNullableTextPointer(row.LastErrorCode), CreatedAt: timestamp(row.CreatedAt), DispatchingAt: nullableTimestamp(row.DispatchingAt), CompletedAt: nullableTimestamp(row.CompletedAt),
	}
}

var _ provideroperations.Repository = ProviderOperationRepository{}

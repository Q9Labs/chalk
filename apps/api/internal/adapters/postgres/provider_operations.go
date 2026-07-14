package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
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
		OperationID:                  canonical.Input.OperationID,
		Effect:                       string(canonical.Input.Effect),
		TenantID:                     uuid(canonical.Input.TenantID),
		SessionID:                    uuid(canonical.Input.SessionID),
		ParticipantSessionID:         uuid(canonical.Input.ParticipantSessionID),
		ParticipantSessionGeneration: providerOptionalInt8(canonical.Input.ParticipantSessionGeneration),
		PublicationSource:            providerText(canonical.Input.PublicationSource),
		RecordingID:                  uuid(canonical.Input.RecordingID),
		RequestFingerprint:           canonical.Fingerprint[:],
		RequestPayload:               []byte(canonical.Payload),
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

func (r ProviderOperationRepository) AppendObservation(ctx context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	canonical, fingerprint, payload, err := provideroperations.CanonicalizeObservation(input)
	if err != nil {
		return provideroperations.Observation{}, err
	}
	if r.transactor == nil {
		return provideroperations.Observation{}, errors.New("provider operation repository has no transaction executor")
	}
	var result provideroperations.Observation
	err = r.transaction(ctx, func(queries providerOperationQuerier) error {
		params := providerObservationIdentityParams{TenantID: uuid(canonical.TenantID), SessionID: uuid(canonical.SessionID)}
		if err := queries.EnsureProviderObservationHead(ctx, params); err != nil {
			return fmt.Errorf("ensure provider observation head: %w", err)
		}
		head, err := queries.LockProviderObservationHead(ctx, params)
		if err != nil {
			return fmt.Errorf("lock provider observation head: %w", err)
		}
		if observationCursorBefore(canonical.Cursor(), provideroperationsCursor(head)) {
			return provideroperations.ErrObservationStale
		}
		if sameObservationCursor(canonical.Cursor(), provideroperationsCursor(head)) {
			existing, getErr := queries.GetProviderObservation(ctx, getProviderObservationParams{
				TenantID: uuid(canonical.TenantID), SessionID: uuid(canonical.SessionID), Incarnation: canonical.Incarnation, Sequence: canonical.Sequence,
			})
			if errors.Is(getErr, pgx.ErrNoRows) {
				row, insertErr := queries.InsertProviderObservation(ctx, insertProviderObservationParams{
					TenantID: uuid(canonical.TenantID), SessionID: uuid(canonical.SessionID), Incarnation: canonical.Incarnation, Sequence: canonical.Sequence, Publications: []byte(payload), ObservationFingerprint: fingerprint[:],
				})
				if insertErr != nil {
					return fmt.Errorf("insert provider observation replay: %w", insertErr)
				}
				result, err = mapProviderObservation(row)
				return err
			}
			if getErr != nil {
				return fmt.Errorf("get provider observation replay: %w", getErr)
			}
			if !bytes.Equal(existing.ObservationFingerprint, fingerprint[:]) {
				return provideroperations.ErrObservationConflict
			}
			result, err = mapProviderObservation(existing)
			return err
		}
		if _, err := queries.UpdateProviderObservationHead(ctx, updateProviderObservationHeadParams{
			TenantID: uuid(canonical.TenantID), SessionID: uuid(canonical.SessionID), Incarnation: canonical.Incarnation, Sequence: canonical.Sequence, ObservationFingerprint: fingerprint[:],
		}); err != nil {
			return fmt.Errorf("advance provider observation head: %w", err)
		}
		row, err := queries.InsertProviderObservation(ctx, insertProviderObservationParams{
			TenantID: uuid(canonical.TenantID), SessionID: uuid(canonical.SessionID), Incarnation: canonical.Incarnation, Sequence: canonical.Sequence, Publications: []byte(payload), ObservationFingerprint: fingerprint[:],
		})
		if err != nil {
			return fmt.Errorf("insert provider observation: %w", err)
		}
		result, err = mapProviderObservation(row)
		return err
	})
	if err != nil {
		return provideroperations.Observation{}, err
	}
	return result, nil
}

func (r ProviderOperationRepository) ListObservations(ctx context.Context, tenantID, sessionID utilities.ID, after *provideroperations.Cursor, limit int) (provideroperations.ObservationPage, error) {
	if tenantID.IsZero() {
		return provideroperations.ObservationPage{}, provideroperations.ErrInvalidTenantID
	}
	if sessionID.IsZero() {
		return provideroperations.ObservationPage{}, provideroperations.ErrInvalidSessionID
	}
	if after != nil && (after.Incarnation < 0 || after.Sequence < 0) {
		return provideroperations.ObservationPage{}, provideroperations.ErrInvalidObservationCursor
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 100 {
		limit = 100
	}
	params := listProviderObservationsParams{TenantID: uuid(tenantID), SessionID: uuid(sessionID), PageLimit: int32(limit + 1)}
	if after != nil {
		params.AfterIncarnation = pgtype.Int8{Int64: after.Incarnation, Valid: true}
		params.AfterSequence = pgtype.Int8{Int64: after.Sequence, Valid: true}
	}
	rows, err := r.queries.ListProviderObservations(ctx, params)
	if err != nil {
		return provideroperations.ObservationPage{}, fmt.Errorf("list provider observations: %w", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	page := provideroperations.ObservationPage{Observations: make([]provideroperations.Observation, 0, len(rows))}
	for _, row := range rows {
		observation, err := mapProviderObservation(row)
		if err != nil {
			return provideroperations.ObservationPage{}, err
		}
		page.Observations = append(page.Observations, observation)
	}
	if hasMore {
		last := page.Observations[len(page.Observations)-1]
		page.Next = &provideroperations.Cursor{Incarnation: last.Incarnation, Sequence: last.Sequence}
	}
	return page, nil
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
		OperationID: row.OperationID, Effect: provideroperations.Effect(row.Effect), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SessionID: utilities.IDFromBytes(row.SessionID.Bytes),
		ParticipantSessionID: nullableID(row.ParticipantSessionID), ParticipantSessionGeneration: providerNullableInt64(row.ParticipantSessionGeneration), PublicationSource: providerNullableTextValue(row.PublicationSource), RecordingID: nullableID(row.RecordingID),
		Fingerprint: fingerprint, Payload: jsonRaw(row.RequestPayload), State: provideroperations.ReceiptState(row.State), Outcome: nullableOutcome(row.Outcome), Reason: providerNullableTextPointer(row.Reason), CreatedAt: timestamp(row.CreatedAt), DispatchingAt: nullableTimestamp(row.DispatchingAt), CompletedAt: nullableTimestamp(row.CompletedAt),
	}
}

func mapProviderObservation(row providerOperationObservationRow) (provideroperations.Observation, error) {
	var fingerprint [32]byte
	copy(fingerprint[:], row.ObservationFingerprint)
	var publications []struct {
		ParticipantSessionID string  `json:"participant_session_id"`
		Source               string  `json:"source"`
		Enabled              bool    `json:"enabled"`
		PublicationID        *string `json:"publication_id"`
	}
	if err := json.Unmarshal(row.Publications, &publications); err != nil {
		return provideroperations.Observation{}, fmt.Errorf("decode provider observation: %w", err)
	}
	result := provideroperations.Observation{TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SessionID: utilities.IDFromBytes(row.SessionID.Bytes), Incarnation: row.Incarnation, Sequence: row.Sequence, Fingerprint: fingerprint, CreatedAt: timestamp(row.CreatedAt), Publications: make([]provideroperations.Publication, 0, len(publications))}
	for _, publication := range publications {
		id, err := utilities.ParseID(publication.ParticipantSessionID)
		if err != nil {
			return provideroperations.Observation{}, fmt.Errorf("decode provider observation participant id: %w", err)
		}
		publicationID := ""
		if publication.PublicationID != nil {
			publicationID = *publication.PublicationID
		}
		result.Publications = append(result.Publications, provideroperations.Publication{ParticipantSessionID: id, Source: publication.Source, Enabled: publication.Enabled, PublicationID: publicationID})
	}
	return result, nil
}

func provideroperationsCursor(row providerOperationObservationHeadRow) provideroperations.Cursor {
	return provideroperations.Cursor{Incarnation: row.Incarnation, Sequence: row.Sequence}
}

func observationCursorBefore(left, right provideroperations.Cursor) bool {
	return left.Incarnation < right.Incarnation || (left.Incarnation == right.Incarnation && left.Sequence < right.Sequence)
}

func sameObservationCursor(left, right provideroperations.Cursor) bool {
	return left.Incarnation == right.Incarnation && left.Sequence == right.Sequence
}

func nullableOutcome(value pgtype.Text) *provideroperations.Outcome {
	if !value.Valid {
		return nil
	}
	outcome := provideroperations.Outcome(value.String)
	return &outcome
}

func providerNullableTextPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func providerNullableTextValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func sameReason(existing *string, requested *string) bool {
	if existing == nil || requested == nil {
		return existing == nil && requested == nil
	}
	return strings.TrimSpace(*existing) == strings.TrimSpace(*requested)
}

func providerOptionalInt8(value int64) pgtype.Int8 {
	if value == 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

func providerNullableInt64(value pgtype.Int8) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}

func providerText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func providerTextPointer(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return providerText(strings.TrimSpace(*value))
}

var _ provideroperations.Repository = ProviderOperationRepository{}

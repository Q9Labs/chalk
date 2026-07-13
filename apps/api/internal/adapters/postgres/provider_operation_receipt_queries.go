package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

const providerOperationReceiptColumns = `
    operation_id, effect, tenant_id, session_id, participant_session_id,
    participant_session_generation, publication_source, recording_id,
    request_fingerprint, request_payload, state, outcome, reason,
    created_at, dispatching_at, completed_at`

type providerOperationIdentityParams struct {
	OperationID string
	Effect      string
}

type getProviderOperationReceiptParams = providerOperationIdentityParams

type insertProviderOperationReceiptParams struct {
	OperationID                  string
	Effect                       string
	TenantID                     pgtype.UUID
	SessionID                    pgtype.UUID
	ParticipantSessionID         pgtype.UUID
	ParticipantSessionGeneration pgtype.Int8
	PublicationSource            pgtype.Text
	RecordingID                  pgtype.UUID
	RequestFingerprint           []byte
	RequestPayload               []byte
}

type completeProviderOperationParams struct {
	Outcome     pgtype.Text
	Reason      pgtype.Text
	OperationID string
	Effect      string
}

func (q *providerOperationQueries) GetProviderOperationReceipt(ctx context.Context, arg getProviderOperationReceiptParams) (providerOperationReceiptRow, error) {
	query := `select ` + providerOperationReceiptColumns + `
from provider_operation_receipts
where operation_id = $1 and effect = $2`
	return scanProviderOperationReceipt(q.db.QueryRow(ctx, query, arg.OperationID, arg.Effect))
}

func (q *providerOperationQueries) InsertProviderOperationReceipt(ctx context.Context, arg insertProviderOperationReceiptParams) (providerOperationReceiptRow, error) {
	query := `insert into provider_operation_receipts (
    operation_id, effect, tenant_id, session_id, participant_session_id,
    participant_session_generation, publication_source, recording_id,
    request_fingerprint, request_payload
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
on conflict (operation_id, effect) do nothing
returning ` + providerOperationReceiptColumns
	return scanProviderOperationReceipt(q.db.QueryRow(
		ctx,
		query,
		arg.OperationID,
		arg.Effect,
		arg.TenantID,
		arg.SessionID,
		arg.ParticipantSessionID,
		arg.ParticipantSessionGeneration,
		arg.PublicationSource,
		arg.RecordingID,
		arg.RequestFingerprint,
		arg.RequestPayload,
	))
}

func (q *providerOperationQueries) MarkProviderOperationDispatching(ctx context.Context, arg providerOperationIdentityParams) (providerOperationReceiptRow, error) {
	query := `update provider_operation_receipts
set state = 'dispatching', dispatching_at = coalesce(dispatching_at, now())
where operation_id = $1 and effect = $2 and state = 'prepared'
returning ` + providerOperationReceiptColumns
	return scanProviderOperationReceipt(q.db.QueryRow(ctx, query, arg.OperationID, arg.Effect))
}

func (q *providerOperationQueries) ResetProviderOperationForRetry(ctx context.Context, arg providerOperationIdentityParams) (providerOperationReceiptRow, error) {
	query := `update provider_operation_receipts
set state = 'prepared', dispatching_at = null
where operation_id = $1 and effect = $2 and state = 'dispatching'
returning ` + providerOperationReceiptColumns
	return scanProviderOperationReceipt(q.db.QueryRow(ctx, query, arg.OperationID, arg.Effect))
}

func (q *providerOperationQueries) CompleteProviderOperation(ctx context.Context, arg completeProviderOperationParams) (providerOperationReceiptRow, error) {
	query := `update provider_operation_receipts
set state = 'completed',
    outcome = $1,
    reason = $2,
    completed_at = coalesce(completed_at, now())
where operation_id = $3 and effect = $4 and state = 'dispatching'
returning ` + providerOperationReceiptColumns
	return scanProviderOperationReceipt(q.db.QueryRow(ctx, query, arg.Outcome, arg.Reason, arg.OperationID, arg.Effect))
}

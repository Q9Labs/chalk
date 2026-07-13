package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

type providerOperationDBTX interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type providerOperationQueries struct {
	db providerOperationDBTX
}

func newProviderOperationQueries(db providerOperationDBTX) *providerOperationQueries {
	return &providerOperationQueries{db: db}
}

type providerOperationQuerier interface {
	GetProviderOperationReceipt(context.Context, getProviderOperationReceiptParams) (providerOperationReceiptRow, error)
	InsertProviderOperationReceipt(context.Context, insertProviderOperationReceiptParams) (providerOperationReceiptRow, error)
	MarkProviderOperationDispatching(context.Context, providerOperationIdentityParams) (providerOperationReceiptRow, error)
	ResetProviderOperationForRetry(context.Context, providerOperationIdentityParams) (providerOperationReceiptRow, error)
	CompleteProviderOperation(context.Context, completeProviderOperationParams) (providerOperationReceiptRow, error)
	EnsureProviderObservationHead(context.Context, providerObservationIdentityParams) error
	LockProviderObservationHead(context.Context, providerObservationIdentityParams) (providerOperationObservationHeadRow, error)
	UpdateProviderObservationHead(context.Context, updateProviderObservationHeadParams) (providerOperationObservationHeadRow, error)
	InsertProviderObservation(context.Context, insertProviderObservationParams) (providerOperationObservationRow, error)
	GetProviderObservation(context.Context, getProviderObservationParams) (providerOperationObservationRow, error)
	ListProviderObservations(context.Context, listProviderObservationsParams) ([]providerOperationObservationRow, error)
}

type providerOperationReceiptRow struct {
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
	State                        string
	Outcome                      pgtype.Text
	Reason                       pgtype.Text
	CreatedAt                    pgtype.Timestamptz
	DispatchingAt                pgtype.Timestamptz
	CompletedAt                  pgtype.Timestamptz
}

type providerOperationObservationRow struct {
	TenantID               pgtype.UUID
	SessionID              pgtype.UUID
	Incarnation            int64
	Sequence               int64
	Publications           []byte
	ObservationFingerprint []byte
	CreatedAt              pgtype.Timestamptz
}

type providerOperationObservationHeadRow struct {
	TenantID               pgtype.UUID
	SessionID              pgtype.UUID
	Incarnation            int64
	Sequence               int64
	ObservationFingerprint []byte
	UpdatedAt              pgtype.Timestamptz
}

type providerOperationScanner interface {
	Scan(...any) error
}

func scanProviderOperationReceipt(scanner providerOperationScanner) (providerOperationReceiptRow, error) {
	var row providerOperationReceiptRow
	err := scanner.Scan(
		&row.OperationID,
		&row.Effect,
		&row.TenantID,
		&row.SessionID,
		&row.ParticipantSessionID,
		&row.ParticipantSessionGeneration,
		&row.PublicationSource,
		&row.RecordingID,
		&row.RequestFingerprint,
		&row.RequestPayload,
		&row.State,
		&row.Outcome,
		&row.Reason,
		&row.CreatedAt,
		&row.DispatchingAt,
		&row.CompletedAt,
	)
	return row, err
}

func scanProviderObservation(scanner providerOperationScanner) (providerOperationObservationRow, error) {
	var row providerOperationObservationRow
	err := scanner.Scan(
		&row.TenantID,
		&row.SessionID,
		&row.Incarnation,
		&row.Sequence,
		&row.Publications,
		&row.ObservationFingerprint,
		&row.CreatedAt,
	)
	return row, err
}

func scanProviderObservationHead(scanner providerOperationScanner) (providerOperationObservationHeadRow, error) {
	var row providerOperationObservationHeadRow
	err := scanner.Scan(
		&row.TenantID,
		&row.SessionID,
		&row.Incarnation,
		&row.Sequence,
		&row.ObservationFingerprint,
		&row.UpdatedAt,
	)
	return row, err
}

package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

const providerObservationColumns = `
    tenant_id, session_id, incarnation, sequence, publications,
    observation_fingerprint, created_at`

const providerObservationHeadColumns = `
    tenant_id, session_id, incarnation, sequence,
    observation_fingerprint, updated_at`

type providerObservationIdentityParams struct {
	TenantID  pgtype.UUID
	SessionID pgtype.UUID
}

type getProviderObservationParams struct {
	TenantID    pgtype.UUID
	SessionID   pgtype.UUID
	Incarnation int64
	Sequence    int64
}

type insertProviderObservationParams struct {
	TenantID               pgtype.UUID
	SessionID              pgtype.UUID
	Incarnation            int64
	Sequence               int64
	Publications           []byte
	ObservationFingerprint []byte
}

type updateProviderObservationHeadParams struct {
	Incarnation            int64
	Sequence               int64
	ObservationFingerprint []byte
	TenantID               pgtype.UUID
	SessionID              pgtype.UUID
}

type listProviderObservationsParams struct {
	TenantID         pgtype.UUID
	SessionID        pgtype.UUID
	AfterIncarnation pgtype.Int8
	AfterSequence    pgtype.Int8
	PageLimit        int32
}

func (q *providerOperationQueries) EnsureProviderObservationHead(ctx context.Context, arg providerObservationIdentityParams) error {
	query := `insert into provider_operation_observation_heads (tenant_id, session_id)
values ($1, $2)
on conflict (tenant_id, session_id) do nothing`
	_, err := q.db.Exec(ctx, query, arg.TenantID, arg.SessionID)
	return err
}

func (q *providerOperationQueries) LockProviderObservationHead(ctx context.Context, arg providerObservationIdentityParams) (providerOperationObservationHeadRow, error) {
	query := `select ` + providerObservationHeadColumns + `
from provider_operation_observation_heads
where tenant_id = $1 and session_id = $2
for update`
	return scanProviderObservationHead(q.db.QueryRow(ctx, query, arg.TenantID, arg.SessionID))
}

func (q *providerOperationQueries) UpdateProviderObservationHead(ctx context.Context, arg updateProviderObservationHeadParams) (providerOperationObservationHeadRow, error) {
	query := `update provider_operation_observation_heads
set incarnation = $1,
    sequence = $2,
    observation_fingerprint = $3,
    updated_at = now()
where tenant_id = $4 and session_id = $5
returning ` + providerObservationHeadColumns
	return scanProviderObservationHead(q.db.QueryRow(
		ctx,
		query,
		arg.Incarnation,
		arg.Sequence,
		arg.ObservationFingerprint,
		arg.TenantID,
		arg.SessionID,
	))
}

func (q *providerOperationQueries) InsertProviderObservation(ctx context.Context, arg insertProviderObservationParams) (providerOperationObservationRow, error) {
	query := `insert into provider_operation_observations (
    tenant_id, session_id, incarnation, sequence, publications, observation_fingerprint
)
values ($1, $2, $3, $4, $5, $6)
returning ` + providerObservationColumns
	return scanProviderObservation(q.db.QueryRow(
		ctx,
		query,
		arg.TenantID,
		arg.SessionID,
		arg.Incarnation,
		arg.Sequence,
		arg.Publications,
		arg.ObservationFingerprint,
	))
}

func (q *providerOperationQueries) GetProviderObservation(ctx context.Context, arg getProviderObservationParams) (providerOperationObservationRow, error) {
	query := `select ` + providerObservationColumns + `
from provider_operation_observations
where tenant_id = $1
  and session_id = $2
  and incarnation = $3
  and sequence = $4`
	return scanProviderObservation(q.db.QueryRow(ctx, query, arg.TenantID, arg.SessionID, arg.Incarnation, arg.Sequence))
}

func (q *providerOperationQueries) ListProviderObservations(ctx context.Context, arg listProviderObservationsParams) ([]providerOperationObservationRow, error) {
	query := `select ` + providerObservationColumns + `
from provider_operation_observations
where tenant_id = $1
  and session_id = $2
  and (
      $3::bigint is null
      or incarnation > $3::bigint
      or (incarnation = $3::bigint and sequence > $4::bigint)
  )
order by incarnation, sequence
limit least($5, 101)`
	rows, err := q.db.Query(ctx, query, arg.TenantID, arg.SessionID, arg.AfterIncarnation, arg.AfterSequence, arg.PageLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]providerOperationObservationRow, 0)
	for rows.Next() {
		row, err := scanProviderObservation(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

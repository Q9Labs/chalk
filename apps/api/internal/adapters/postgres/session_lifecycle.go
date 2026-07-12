package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type sessionLifecycleTransactor interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type SessionLifecycleRepository struct {
	transactor sessionLifecycleTransactor
}

func NewSessionLifecycleRepository(transactor sessionLifecycleTransactor) SessionLifecycleRepository {
	return SessionLifecycleRepository{transactor: transactor}
}

func (r SessionLifecycleRepository) transaction(ctx context.Context, work func(*sqlc.Queries) error) error {
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin lifecycle transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `select
		set_config('synchronous_commit', 'on', true),
		set_config('lock_timeout', '750ms', true),
		set_config('statement_timeout', '2s', true),
		set_config('transaction_timeout', '3s', true)`); err != nil {
		return fmt.Errorf("set lifecycle transaction bounds: %w", err)
	}

	var synchronousCommit string
	if err := tx.QueryRow(ctx, "show synchronous_commit").Scan(&synchronousCommit); err != nil {
		return fmt.Errorf("verify lifecycle synchronous commit: %w", err)
	}
	if synchronousCommit != "on" {
		return sessionlifecycle.ErrSynchronousCommit
	}

	if err := work(sqlc.New(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit lifecycle transaction: %w", err)
	}

	return nil
}

func lockLifecycleControl(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) error {
	_, err := queries.LockSyncSessionControlForUpdate(ctx, sqlc.LockSyncSessionControlForUpdateParams{
		TenantID:  uuid(tenantID),
		RoomID:    uuid(roomID),
		SessionID: uuid(sessionID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sessionlifecycle.ErrSessionNotFound
	}
	if err != nil {
		return fmt.Errorf("lock lifecycle control: %w", err)
	}

	return nil
}

func lockLifecycleSession(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (sqlc.RoomSession, error) {
	session, err := queries.LockLifecycleRoomSessionForUpdate(ctx, sqlc.LockLifecycleRoomSessionForUpdateParams{
		TenantID:  uuid(tenantID),
		RoomID:    uuid(roomID),
		SessionID: uuid(sessionID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.RoomSession{}, sessionlifecycle.ErrSessionNotFound
	}
	if err != nil {
		return sqlc.RoomSession{}, fmt.Errorf("lock lifecycle session: %w", err)
	}

	return session, nil
}

func lockLifecycleParticipant(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, participantID utilities.ID) (sqlc.Participant, error) {
	participant, err := queries.LockLifecycleParticipantForUpdate(ctx, sqlc.LockLifecycleParticipantForUpdateParams{
		TenantID:             uuid(tenantID),
		RoomID:               uuid(roomID),
		SessionID:            uuid(sessionID),
		ParticipantSessionID: uuid(participantID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Participant{}, sessionlifecycle.ErrParticipantNotFound
	}
	if err != nil {
		return sqlc.Participant{}, fmt.Errorf("lock lifecycle participant: %w", err)
	}

	return participant, nil
}

func idempotencyConflict(intent sqlc.SyncLifecycleIntent, request sessionlifecycle.Request) error {
	if bytes.Equal(intent.RequestFingerprint, request.Fingerprint[:]) {
		return nil
	}

	return sessionlifecycle.ErrIdempotencyConflict
}

func mapLifecycleSession(row sqlc.RoomSession) sessionlifecycle.Session {
	return sessionlifecycle.Session{
		ID:        utilities.IDFromBytes(row.ID.Bytes),
		TenantID:  utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:    utilities.IDFromBytes(row.RoomID.Bytes),
		Status:    row.Status,
		CreatedAt: timestamp(row.CreatedAt),
	}
}

func mapLifecycleParticipant(row sqlc.Participant) sessionlifecycle.Participant {
	return sessionlifecycle.Participant{
		ID:         utilities.IDFromBytes(row.ID.Bytes),
		TenantID:   utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:     utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID:  utilities.IDFromBytes(row.SessionID.Bytes),
		Generation: row.Generation,
		Status:     row.Status,
	}
}

func mapLifecycleIntent(row sqlc.SyncLifecycleIntent) sessionlifecycle.Intent {
	return sessionlifecycle.Intent{
		ID:                    utilities.IDFromBytes(row.LifecycleIntentID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		RoomID:                utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID:             utilities.IDFromBytes(row.SessionID.Bytes),
		RequestKey:            row.RequestKey,
		IntentName:            row.IntentName,
		ParticipantID:         nullableID(row.ParticipantSessionID),
		ParticipantGeneration: nullableInt64(row.ParticipantSessionGeneration),
		Status:                row.Status,
		CreatedAt:             timestamp(row.CreatedAt),
	}
}

func nullableInt64(value pgtype.Int8) int64 {
	if !value.Valid {
		return 0
	}

	return value.Int64
}

var _ sessionlifecycle.Repository = SessionLifecycleRepository{}

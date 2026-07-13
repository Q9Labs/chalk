package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
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

func (r SessionLifecycleRepository) transaction(ctx context.Context, work func(*sqlc.Queries, pgx.Tx) error) error {
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

	if err := work(sqlc.New(tx), tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit lifecycle transaction: %w", err)
	}

	return nil
}

func lockLifecycleControlRow(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (sqlc.SyncSessionControl, error) {
	control, err := queries.LockSyncSessionControlForUpdate(ctx, sqlc.LockSyncSessionControlForUpdateParams{
		TenantID:  uuid(tenantID),
		RoomID:    uuid(roomID),
		SessionID: uuid(sessionID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncSessionControl{}, sessionlifecycle.ErrSessionNotFound
	}
	if err != nil {
		return sqlc.SyncSessionControl{}, fmt.Errorf("lock lifecycle control: %w", err)
	}
	return control, nil
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

type lifecycleJourney struct {
	JourneyID     utilities.ID
	ParentEventID utilities.ID
	TraceID       string
	SpanID        string
}

func lifecycleJourneyFromContext(ctx context.Context) (lifecycleJourney, error) {
	journeyID, ok := observability.JourneyIDFromContext(ctx)
	var err error
	if !ok {
		journeyID, err = utilities.NewID()
		if err != nil {
			return lifecycleJourney{}, err
		}
	}
	parentID, err := utilities.NewID()
	if err != nil {
		return lifecycleJourney{}, err
	}
	result := lifecycleJourney{JourneyID: journeyID, ParentEventID: parentID}
	span := trace.SpanContextFromContext(ctx)
	if span.IsValid() {
		result.TraceID = span.TraceID().String()
		result.SpanID = span.SpanID().String()
	}
	return result, nil
}

func persistLifecycleJourneyRoot(ctx context.Context, tx pgx.Tx, journey lifecycleJourney, name string) error {
	attributes, err := json.Marshal(map[string]any{"request": name})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,trace_id,span_id,attributes) values($1,$2,0,now(),$3,'api_request','accepted','server','api','visible',$4,$5,$6) on conflict(event_id) do nothing`, uuid(journey.ParentEventID), uuid(journey.JourneyID), name, optionalText(journey.TraceID), optionalText(journey.SpanID), attributes)
	return err
}

var _ sessionlifecycle.Repository = SessionLifecycleRepository{}

package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) GetSyncTokenSubject(ctx context.Context, key synctokens.SubjectKey) (synctokens.Input, error) {
	var subject synctokens.Input
	err := r.transaction(ctx, func(queries *sqlc.Queries, _ pgx.Tx) error {
		row, err := queries.GetSyncTokenSubject(ctx, sqlc.GetSyncTokenSubjectParams{
			TenantID: uuid(key.TenantID), SpaceID: uuid(key.SpaceID), EpisodeID: uuid(key.EpisodeID), ParticipantID: uuid(key.ParticipantID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return synctokens.ErrSubjectNotFound
		}
		if err != nil {
			return fmt.Errorf("get sync token subject: %w", err)
		}
		subject = synctokens.Input{
			TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes),
			EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes), StartedAt: nullableTimestamp(row.StartedAt), ParticipantID: utilities.IDFromBytes(row.ParticipantID.Bytes),
			ParticipantGeneration: row.Generation, AdmissionLifecycleIntentID: utilities.IDFromBytes(row.AdmissionLifecycleIntentID.Bytes),
			DisplayName: row.Name.String, Role: row.Role, Capabilities: append([]string(nil), row.Capabilities...),
		}
		return nil
	})
	return subject, err
}

func (r EpisodeLifecycleRepository) SetParticipantMediaConnection(ctx context.Context, key synctokens.SubjectKey, generation int64, connectionID string) error {
	return r.transaction(ctx, func(_ *sqlc.Queries, tx pgx.Tx) error {
		result, err := tx.Exec(ctx, `update participants set media_connection_id = $6, media_connection_generation = $5
 where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5 and status in ('joining', 'active')`,
			uuid(key.TenantID), uuid(key.SpaceID), uuid(key.EpisodeID), uuid(key.ParticipantID), generation, connectionID)
		if err != nil {
			return fmt.Errorf("set current participant media connection: %w", err)
		}
		if result.RowsAffected() != 1 {
			return synctokens.ErrSubjectNotFound
		}
		return nil
	})
}

func (r EpisodeLifecycleRepository) CheckParticipantMediaConnection(ctx context.Context, key synctokens.SubjectKey, generation int64, connectionID string) error {
	return r.transaction(ctx, func(_ *sqlc.Queries, tx pgx.Tx) error {
		var matches bool
		err := tx.QueryRow(ctx, `select exists(select 1 from participants
 where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5 and status = 'active'
 and (media_connection_generation is distinct from generation or media_connection_id is null or media_connection_id = $6))`,
			uuid(key.TenantID), uuid(key.SpaceID), uuid(key.EpisodeID), uuid(key.ParticipantID), generation, connectionID).Scan(&matches)
		if err != nil {
			return fmt.Errorf("check current participant media connection: %w", err)
		}
		if !matches {
			return accessgrants.ErrConnectionSuperseded
		}
		return nil
	})
}

func (r EpisodeLifecycleRepository) ReplaceParticipantMediaConnection(ctx context.Context, key synctokens.SubjectKey, generation int64, previous, next string) error {
	return r.transaction(ctx, func(_ *sqlc.Queries, tx pgx.Tx) error {
		result, err := tx.Exec(ctx, `update participants set media_connection_id = $7, media_connection_generation = $5
 where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5 and status = 'active'
 and (media_connection_generation is distinct from generation or media_connection_id is null or media_connection_id = $6)`,
			uuid(key.TenantID), uuid(key.SpaceID), uuid(key.EpisodeID), uuid(key.ParticipantID), generation, previous, next)
		if err != nil {
			return fmt.Errorf("replace current participant media connection: %w", err)
		}
		if result.RowsAffected() != 1 {
			return accessgrants.ErrConnectionSuperseded
		}
		return nil
	})
}

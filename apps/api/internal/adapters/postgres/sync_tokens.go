package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
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

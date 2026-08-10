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
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

type episodeLifecycleTransactor interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type EpisodeLifecycleRepository struct {
	transactor episodeLifecycleTransactor
}

func NewEpisodeLifecycleRepository(transactor episodeLifecycleTransactor) EpisodeLifecycleRepository {
	return EpisodeLifecycleRepository{transactor: transactor}
}

func (r EpisodeLifecycleRepository) transaction(ctx context.Context, work func(*sqlc.Queries, pgx.Tx) error) error {
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
		return episodes.ErrSynchronousCommit
	}

	if err := work(sqlc.New(tx), tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit lifecycle transaction: %w", err)
	}

	return nil
}

func lockLifecycleControlRow(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID) (sqlc.SyncEpisodeControl, error) {
	control, err := queries.LockSyncEpisodeControlForUpdate(ctx, sqlc.LockSyncEpisodeControlForUpdateParams{
		TenantID:  uuid(tenantID),
		SpaceID:   uuid(spaceID),
		EpisodeID: uuid(episodeID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncEpisodeControl{}, episodes.ErrEpisodeNotFound
	}
	if err != nil {
		return sqlc.SyncEpisodeControl{}, fmt.Errorf("lock lifecycle control: %w", err)
	}
	return control, nil
}

func lockLifecycleEpisode(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID) (sqlc.Episode, error) {
	episode, err := queries.LockLifecycleEpisodeForUpdate(ctx, sqlc.LockLifecycleEpisodeForUpdateParams{
		TenantID:  uuid(tenantID),
		SpaceID:   uuid(spaceID),
		EpisodeID: uuid(episodeID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Episode{}, episodes.ErrEpisodeNotFound
	}
	if err != nil {
		return sqlc.Episode{}, fmt.Errorf("lock lifecycle episode: %w", err)
	}

	return episode, nil
}

func lockLifecycleParticipant(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, participantID utilities.ID) (sqlc.Participant, error) {
	participant, err := queries.LockLifecycleParticipantForUpdate(ctx, sqlc.LockLifecycleParticipantForUpdateParams{
		TenantID:      uuid(tenantID),
		SpaceID:       uuid(spaceID),
		EpisodeID:     uuid(episodeID),
		ParticipantID: uuid(participantID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Participant{}, episodes.ErrParticipantNotFound
	}
	if err != nil {
		return sqlc.Participant{}, fmt.Errorf("lock lifecycle participant: %w", err)
	}

	return participant, nil
}

func idempotencyConflict(intent sqlc.SyncLifecycleIntent, request episodes.Request) error {
	if bytes.Equal(intent.RequestFingerprint, request.Fingerprint[:]) {
		return nil
	}

	return episodes.ErrIdempotencyConflict
}

func mapLifecycleEpisode(row sqlc.Episode) episodes.Episode {
	return episodes.Episode{
		ID:                 utilities.IDFromBytes(row.ID.Bytes),
		TenantID:           utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:            utilities.IDFromBytes(row.SpaceID.Bytes),
		Status:             row.Status,
		Metadata:           append([]byte(nil), row.Metadata...),
		ConfigSnapshot:     append([]byte(nil), row.ConfigSnapshot...),
		EndReason:          nullableText(row.EndReason),
		StartedAt:          timestamp(row.StartedAt),
		EndedAt:            timestamp(row.EndedAt),
		DeadlineAt:         timestamp(row.DeadlineAt),
		DeadlineGeneration: row.DeadlineGeneration,
		UpdatedAt:          timestamp(row.UpdatedAt),
		CreatedAt:          timestamp(row.CreatedAt),
	}
}

func (r EpisodeLifecycleRepository) GetEpisode(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) (episodes.Episode, error) {
	var result episodes.Episode
	err := r.transaction(ctx, func(queries *sqlc.Queries, _ pgx.Tx) error {
		row, err := queries.GetTenantEpisode(ctx, sqlc.GetTenantEpisodeParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), ID: uuid(episodeID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrEpisodeNotFound
		}
		if err != nil {
			return fmt.Errorf("get episode: %w", err)
		}
		result = mapLifecycleEpisode(row)
		return nil
	})
	return result, err
}

func (r EpisodeLifecycleRepository) ListEpisodes(ctx context.Context, tenantID, spaceID utilities.ID, page pagination.PageRequest) (episodes.EpisodeList, error) {
	var result episodes.EpisodeList
	err := r.transaction(ctx, func(queries *sqlc.Queries, _ pgx.Tx) error {
		params := sqlc.ListTenantEpisodesParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), PageSize: int32(page.Size())}
		if cursor := page.Cursor(); cursor != nil {
			params.CursorSet = true
			params.CursorCreatedAt = timestamptz(&cursor.CreatedAt)
			params.CursorID = uuid(cursor.ID)
		}
		rows, err := queries.ListTenantEpisodes(ctx, params)
		if err != nil {
			return fmt.Errorf("list episodes: %w", err)
		}
		items := make([]episodes.Episode, 0, len(rows))
		for _, row := range rows {
			items = append(items, mapLifecycleEpisode(row))
		}
		hasMore := len(items) == page.Size()
		result = episodes.EpisodeList{Episodes: items, Page: pagination.Page{PageSize: page.Size(), HasMore: hasMore}}
		if hasMore && len(items) > 0 {
			last := items[len(items)-1]
			result.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
		}
		return nil
	})
	return result, err
}

func mapLifecycleParticipant(row sqlc.Participant) episodes.Participant {
	return episodes.Participant{
		ID:           utilities.IDFromBytes(row.ID.Bytes),
		TenantID:     utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:      utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID:    utilities.IDFromBytes(row.EpisodeID.Bytes),
		AccountID:    nullableID(row.AccountID),
		IdentityID:   nullableID(row.IdentityID),
		Role:         row.Role,
		Capabilities: append([]string(nil), row.Capabilities...),
		Generation:   row.Generation,
		Status:       row.Status,
	}
}

func mapLifecycleIntent(row sqlc.SyncLifecycleIntent) episodes.Intent {
	return episodes.Intent{
		ID:                    utilities.IDFromBytes(row.LifecycleIntentID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:               utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID:             utilities.IDFromBytes(row.EpisodeID.Bytes),
		RequestKey:            row.RequestKey,
		IntentName:            row.IntentName,
		ParticipantID:         nullableID(row.ParticipantID),
		ParticipantGeneration: nullableInt64(row.ParticipantGeneration),
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

var _ episodes.Repository = EpisodeLifecycleRepository{}

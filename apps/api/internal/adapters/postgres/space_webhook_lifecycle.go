package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r SpaceRepository) archiveSpaceWithWebhook(ctx context.Context, tenantID, spaceID utilities.ID) (spaces.Space, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return spaces.Space{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	beforeRow, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, err
	}
	before := mapSpace(beforeRow)
	if before.ArchivedAt != nil {
		if err := tx.Commit(ctx); err != nil {
			return spaces.Space{}, err
		}
		return r.withSpaceRoles(ctx, before)
	}
	row, err := queries.ArchiveTenantSpace(ctx, sqlc.ArchiveTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, err
	}
	after := mapSpace(row)
	if err := persistSpaceLifecycleJourney(ctx, tx, webhooks.EventSpaceArchived, after.UpdatedAt); err != nil {
		return spaces.Space{}, fmt.Errorf("persist space.archived journey: %w", err)
	}
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{
		TenantID: tenantID, EventName: webhooks.EventSpaceArchived, SemanticKey: "space:" + spaceID.String() + ":archived:" + after.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ResourceType: "space", ResourceID: spaceID, OccurredAt: after.UpdatedAt,
		Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeSpaceEvent(metadata, spaceWebhookSnapshot(after), nil)
		},
	})
	if err != nil {
		return spaces.Space{}, fmt.Errorf("produce space.archived webhook: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return spaces.Space{}, err
	}
	metric.Record(ctx)
	return r.withSpaceRoles(ctx, after)
}

func (r SpaceRepository) restoreSpaceWithWebhook(ctx context.Context, tenantID, spaceID utilities.ID) (spaces.Space, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return spaces.Space{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	beforeRow, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, err
	}
	before := mapSpace(beforeRow)
	if before.ArchivedAt == nil {
		if err := tx.Commit(ctx); err != nil {
			return spaces.Space{}, err
		}
		return r.withSpaceRoles(ctx, before)
	}
	row, err := queries.RestoreTenantSpace(ctx, sqlc.RestoreTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, err
	}
	after := mapSpace(row)
	if err := persistSpaceLifecycleJourney(ctx, tx, webhooks.EventSpaceRestored, after.UpdatedAt); err != nil {
		return spaces.Space{}, fmt.Errorf("persist space.restored journey: %w", err)
	}
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{
		TenantID: tenantID, EventName: webhooks.EventSpaceRestored, SemanticKey: "space:" + spaceID.String() + ":restored:" + after.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ResourceType: "space", ResourceID: spaceID, OccurredAt: after.UpdatedAt,
		Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeSpaceEvent(metadata, spaceWebhookSnapshot(after), nil)
		},
	})
	if err != nil {
		return spaces.Space{}, fmt.Errorf("produce space.restored webhook: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return spaces.Space{}, err
	}
	metric.Record(ctx)
	return r.withSpaceRoles(ctx, after)
}

// persistSpaceLifecycleJourney records the committed Space transition inside
// the same transaction as the archive/restore write and webhook outbox event.
// Its attributes intentionally contain only the bounded transition label;
// names, slugs, policies, request bodies, and other tenant payloads never
// enter the journey ledger.
func persistSpaceLifecycleJourney(ctx context.Context, tx pgx.Tx, name webhooks.EventName, occurredAt time.Time) error {
	if name != webhooks.EventSpaceArchived && name != webhooks.EventSpaceRestored {
		return fmt.Errorf("unsupported Space lifecycle journey transition %q", name)
	}
	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return err
	}
	if err := persistLifecycleJourneyRoot(ctx, tx, journey, string(name)+"_requested"); err != nil {
		return err
	}
	eventID, err := utilities.NewID()
	if err != nil {
		return err
	}
	attributes, err := json.Marshal(map[string]string{"transition": string(name)})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,parent_event_id,trace_id,span_id,attributes) values($1,$2,1,$3,$4,'terminal','succeeded','server','api','complete',$5,$6,$7,$8) on conflict(event_id) do nothing`, uuid(eventID), uuid(journey.JourneyID), occurredAt, name, uuid(journey.ParentEventID), optionalText(journey.TraceID), optionalText(journey.SpanID), attributes)
	return err
}

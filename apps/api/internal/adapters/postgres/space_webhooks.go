package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r SpaceRepository) createSpaceWithWebhook(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return spaces.Space{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	row, err := queries.CreateSpace(ctx, createSpaceParams(input))
	if err != nil {
		if uniqueConstraintViolation(err, "spaces_tenant_id_slug_key") {
			return spaces.Space{}, spaces.ErrSpaceSlugAlreadyUsed
		}
		return spaces.Space{}, err
	}
	space := mapSpace(row)
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{
		TenantID:     input.TenantID,
		EventName:    "space.created",
		SemanticKey:  "space:" + space.ID.String() + ":created",
		ResourceType: "space",
		ResourceID:   space.ID,
		OccurredAt:   space.CreatedAt,
		Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeSpaceEvent(metadata, spaceWebhookSnapshot(space), nil)
		},
	})
	if err != nil {
		return spaces.Space{}, fmt.Errorf("produce space.created webhook: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return spaces.Space{}, err
	}
	metric.Record(ctx)
	return r.withSpaceRoles(ctx, space)
}

func (r SpaceRepository) updateSpaceWithWebhook(ctx context.Context, tenantID, spaceID utilities.ID, input spaces.UpdateSpaceInput) (spaces.Space, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return spaces.Space{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if _, err = tx.Exec(ctx, `select id from spaces where tenant_id=$1 and id=$2 for update`, uuid(tenantID), uuid(spaceID)); err != nil {
		return spaces.Space{}, err
	}
	beforeRow, err := queries.GetTenantSpace(ctx, sqlc.GetTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, err
	}
	before := mapSpace(beforeRow)
	changed := spaceChangedFields(before, input)
	if len(changed) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return spaces.Space{}, err
		}
		return r.withSpaceRoles(ctx, before)
	}
	row, err := queries.UpdateTenantSpace(ctx, sqlc.UpdateTenantSpaceParams{
		TenantID:                         uuid(tenantID),
		ID:                               uuid(spaceID),
		NameSet:                          input.Name.Set,
		Name:                             requiredText(input.Name),
		SlugSet:                          input.Slug.Set,
		Slug:                             requiredText(input.Slug),
		MediaPlaneSet:                    input.MediaPlane.Set,
		MediaPlane:                       requiredText(input.MediaPlane),
		MetadataSet:                      input.Metadata.Set,
		Metadata:                         jsonBytes(input.Metadata.Value),
		RecurringPolicySet:               input.RecurringPolicy.Set,
		RecurringPolicy:                  jsonBytes(input.RecurringPolicy.Value),
		AdmissionPolicySet:               input.AdmissionPolicy.Set,
		AdmissionPolicy:                  jsonBytes(input.AdmissionPolicy.Value),
		DefaultEpisodeDurationSecondsSet: input.DefaultEpisodeDurationSeconds.Set,
		DefaultEpisodeDurationSeconds:    optionalInt32(input.DefaultEpisodeDurationSeconds),
		MaximumEpisodeDurationSecondsSet: input.MaximumEpisodeDurationSeconds.Set,
		MaximumEpisodeDurationSeconds:    optionalInt32(input.MaximumEpisodeDurationSeconds),
		LingerWindowSecondsSet:           input.LingerWindowSeconds.Set,
		LingerWindowSeconds:              optionalInt32(input.LingerWindowSeconds),
	})
	if err != nil {
		return spaces.Space{}, err
	}
	after := mapSpace(row)
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{
		TenantID:     tenantID,
		EventName:    "space.updated",
		SemanticKey:  "space:" + spaceID.String() + ":space.updated:" + after.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ResourceType: "space",
		ResourceID:   spaceID,
		OccurredAt:   after.UpdatedAt,
		Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeSpaceEvent(metadata, spaceWebhookSnapshot(after), changed)
		},
	})
	if err != nil {
		return spaces.Space{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return spaces.Space{}, err
	}
	metric.Record(ctx)
	return r.withSpaceRoles(ctx, after)
}

func spaceChangedFields(before spaces.Space, input spaces.UpdateSpaceInput) []string {
	result := []string{}
	if input.Name.Set && input.Name.Value != nil && *input.Name.Value != before.Name {
		result = append(result, "name")
	}
	if input.Slug.Set && input.Slug.Value != nil && *input.Slug.Value != before.Slug {
		result = append(result, "slug")
	}
	if input.MediaPlane.Set && input.MediaPlane.Value != nil && *input.MediaPlane.Value != before.MediaPlane {
		result = append(result, "media_plane")
	}
	if input.Metadata.Set && !semanticJSONEqual(input.Metadata.Value, before.Metadata) {
		result = append(result, "metadata")
	}
	if input.RecurringPolicy.Set && !semanticJSONEqual(input.RecurringPolicy.Value, before.RecurringPolicy) {
		result = append(result, "recurring_policy")
	}
	if input.AdmissionPolicy.Set && !semanticJSONEqual(input.AdmissionPolicy.Value, before.AdmissionPolicy) {
		result = append(result, "admission_policy")
	}
	if input.DefaultEpisodeDurationSeconds.Set && input.DefaultEpisodeDurationSeconds.Value != nil && *input.DefaultEpisodeDurationSeconds.Value != before.DefaultEpisodeDurationSeconds {
		result = append(result, "default_episode_duration_seconds")
	}
	if input.MaximumEpisodeDurationSeconds.Set && input.MaximumEpisodeDurationSeconds.Value != nil && *input.MaximumEpisodeDurationSeconds.Value != before.MaximumEpisodeDurationSeconds {
		result = append(result, "maximum_episode_duration_seconds")
	}
	if input.LingerWindowSeconds.Set && input.LingerWindowSeconds.Value != nil && *input.LingerWindowSeconds.Value != before.LingerWindowSeconds {
		result = append(result, "linger_window_seconds")
	}
	slices.Sort(result)
	return result
}

func semanticJSONEqual(left, right []byte) bool {
	if len(left) == 0 && len(right) == 0 {
		return true
	}
	var leftValue, rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return false
	}
	return reflect.DeepEqual(leftValue, rightValue)
}

func spaceWebhookSnapshot(value spaces.Space) webhooks.SpaceSnapshot {
	return webhooks.SpaceSnapshot{ID: value.ID.String(), Name: value.Name, Slug: value.Slug, MediaPlane: value.MediaPlane, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}

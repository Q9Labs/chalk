package postgres

import (
	"bytes"
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
	// CreateSpace locks the Tenant row; take the later journey write intent first,
	// matching delivery and purge even when a purge fence is already queued.
	if _, err := tx.Exec(ctx, `lock table observability_journey_events in row exclusive mode`); err != nil {
		return spaces.Space{}, err
	}
	queries := sqlc.New(tx)
	if input.RequestKey != "" {
		_, err := queries.ReserveSpaceCreateRequest(ctx, sqlc.ReserveSpaceCreateRequestParams{
			TenantID:           uuid(input.TenantID),
			RequestKey:         input.RequestKey,
			RequestFingerprint: input.RequestFingerprint[:],
			SpaceID:            uuid(input.ID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			existing, getErr := queries.GetSpaceCreateRequest(ctx, sqlc.GetSpaceCreateRequestParams{
				TenantID: uuid(input.TenantID), RequestKey: input.RequestKey,
			})
			if getErr != nil {
				return spaces.Space{}, fmt.Errorf("get space create replay: %w", getErr)
			}
			if !bytes.Equal(existing.RequestFingerprint, input.RequestFingerprint[:]) {
				return spaces.Space{}, spaces.ErrIdempotencyConflict
			}
			if !existing.SpaceID.Valid {
				return spaces.Space{}, errors.New("space create replay has no resource")
			}
			row, getErr := queries.GetTenantSpace(ctx, sqlc.GetTenantSpaceParams{
				TenantID: uuid(input.TenantID), ID: existing.SpaceID,
			})
			if errors.Is(getErr, pgx.ErrNoRows) {
				return spaces.Space{}, spaces.ErrSpaceNotFound
			}
			if getErr != nil {
				return spaces.Space{}, fmt.Errorf("get space create replay resource: %w", getErr)
			}
			space := mapSpace(row)
			if err := tx.Commit(ctx); err != nil {
				return spaces.Space{}, fmt.Errorf("commit space create replay: %w", err)
			}
			return r.withSpaceRoles(ctx, space)
		}
		if err != nil {
			return spaces.Space{}, fmt.Errorf("reserve space create request: %w", err)
		}
	}
	row, err := queries.CreateSpace(ctx, createSpaceParams(input))
	if err != nil {
		if uniqueConstraintViolation(err, "spaces_tenant_id_slug_key") {
			return spaces.Space{}, spaces.ErrSpaceSlugAlreadyUsed
		}
		return spaces.Space{}, err
	}
	space := mapCreatedSpace(row)
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{
		TenantID:     input.TenantID,
		EventName:    webhooks.EventSpaceCreated,
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
	settingChanged := input.MediaPlaneSetting.Set && !samePlaneSetting(before.MediaPlaneSetting, input.MediaPlaneSetting.Value)
	if len(changed) == 0 && !settingChanged {
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
		MediaPlaneSettingSet:             input.MediaPlaneSetting.Set,
		MediaPlaneSetting:                optionalPlaneSetting(input.MediaPlaneSetting),
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
		RecordingPolicySet:               input.RecordingPolicy.Set,
		RecordingPolicy:                  optionalRecordingPolicy(input.RecordingPolicy),
		TranscriptionPolicySet:           input.TranscriptionPolicy.Set,
		TranscriptLanguageSet:            input.TranscriptLanguage.Set,
		TranscriptLanguage:               text(optionalLanguageString(input.TranscriptLanguage.Value)),
		TranscriptionPolicy:              optionalTranscriptionPolicy(input.TranscriptionPolicy),
	})
	if err != nil {
		return spaces.Space{}, err
	}
	after := mapSpace(row)
	if len(changed) == 0 {
		// Only the media plane setting changed. The webhook contract does not carry it,
		// and the media_plane it reports did not change.
		if err := tx.Commit(ctx); err != nil {
			return spaces.Space{}, err
		}
		return r.withSpaceRoles(ctx, after)
	}
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{
		TenantID:     tenantID,
		EventName:    webhooks.EventSpaceUpdated,
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

func samePlaneSetting(a, b *spaces.MediaPlaneProvider) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
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
	if input.RecordingPolicy.Set && input.RecordingPolicy.Value != nil && *input.RecordingPolicy.Value != before.RecordingPolicy {
		result = append(result, "recording_policy")
	}
	if input.TranscriptionPolicy.Set && input.TranscriptionPolicy.Value != nil && *input.TranscriptionPolicy.Value != before.TranscriptionPolicy {
		result = append(result, "transcription_policy")
	}
	if input.TranscriptLanguage.Set && !reflect.DeepEqual(input.TranscriptLanguage.Value, before.TranscriptLanguage) {
		result = append(result, "transcript_language")
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
	return webhooks.SpaceSnapshot{ID: value.ID.String(), Name: value.Name, Slug: value.Slug, MediaPlane: value.MediaPlane, ArchivedAt: value.ArchivedAt, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}

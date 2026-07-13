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
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r RoomRepository) createRoomWithWebhook(ctx context.Context, input rooms.CreateRoomInput) (rooms.Room, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return rooms.Room{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	row, err := queries.CreateRoom(ctx, sqlc.CreateRoomParams{ID: uuid(input.ID), Name: input.Name, TenantID: uuid(input.TenantID), Status: input.Status, Slug: input.Slug, MediaPlane: input.MediaPlane, Metadata: jsonBytes(input.Metadata), RecurringPolicy: jsonBytes(input.RecurringPolicy), CreatedByUserID: uuid(input.CreatedByUserID)})
	if err != nil {
		if uniqueConstraintViolation(err, "rooms_tenant_id_slug_key") {
			return rooms.Room{}, rooms.ErrRoomSlugAlreadyUsed
		}
		return rooms.Room{}, err
	}
	room := mapRoom(row)
	snapshot := roomWebhookSnapshot(room)
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: input.TenantID, EventName: "room.created", SemanticKey: "room:" + room.ID.String() + ":created", ResourceType: "room", ResourceID: room.ID, OccurredAt: room.CreatedAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return webhooks.EncodeRoomEvent(metadata, snapshot, nil)
	}})
	if err != nil {
		return rooms.Room{}, fmt.Errorf("produce room.created webhook: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return rooms.Room{}, err
	}
	metric.Record(ctx)
	return room, nil
}

func (r RoomRepository) updateRoomWithWebhook(ctx context.Context, tenantID, roomID utilities.ID, input rooms.UpdateRoomInput) (rooms.Room, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return rooms.Room{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if _, err = tx.Exec(ctx, `select id from rooms where tenant_id=$1 and id=$2 for update`, uuid(tenantID), uuid(roomID)); err != nil {
		return rooms.Room{}, err
	}
	beforeRow, err := queries.GetTenantRoom(ctx, sqlc.GetTenantRoomParams{TenantID: uuid(tenantID), ID: uuid(roomID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Room{}, rooms.ErrRoomNotFound
	}
	if err != nil {
		return rooms.Room{}, err
	}
	before := mapRoom(beforeRow)
	changed := roomChangedFields(before, input)
	if len(changed) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return rooms.Room{}, err
		}
		return before, nil
	}
	row, err := queries.UpdateTenantRoom(ctx, sqlc.UpdateTenantRoomParams{TenantID: uuid(tenantID), ID: uuid(roomID), NameSet: input.Name.Set, Name: requiredText(input.Name), StatusSet: input.Status.Set, Status: requiredText(input.Status), SlugSet: input.Slug.Set, Slug: requiredText(input.Slug), MediaPlaneSet: input.MediaPlane.Set, MediaPlane: requiredText(input.MediaPlane), MetadataSet: input.Metadata.Set, Metadata: jsonBytes(input.Metadata.Value), RecurringPolicySet: input.RecurringPolicy.Set, RecurringPolicy: jsonBytes(input.RecurringPolicy.Value)})
	if err != nil {
		return rooms.Room{}, err
	}
	after := mapRoom(row)
	eventName := "room.updated"
	if before.Status == rooms.StatusActive && after.Status == rooms.StatusArchived {
		eventName = "room.archived"
	} else if before.Status == rooms.StatusArchived && after.Status == rooms.StatusActive {
		eventName = "room.restored"
	}
	if eventName != "room.updated" {
		changed = nil
	}
	snapshot := roomWebhookSnapshot(after)
	semanticKey := "room:" + roomID.String() + ":" + eventName + ":" + after.UpdatedAt.UTC().Format(time.RFC3339Nano)
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: eventName, SemanticKey: semanticKey, ResourceType: "room", ResourceID: roomID, OccurredAt: after.UpdatedAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return webhooks.EncodeRoomEvent(metadata, snapshot, changed)
	}})
	if err != nil {
		return rooms.Room{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return rooms.Room{}, err
	}
	metric.Record(ctx)
	return after, nil
}

func (r RoomRepository) createSessionWithWebhook(ctx context.Context, input rooms.CreateSessionInput) (rooms.Session, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return rooms.Session{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	row, err := queries.CreateRoomSession(ctx, sqlc.CreateRoomSessionParams{ID: uuid(input.ID), Status: input.Status, Metadata: jsonBytes(input.Metadata), RoomID: uuid(input.RoomID), TenantID: uuid(input.TenantID), CreatedByUserID: uuid(input.CreatedByUserID), StartedAt: timestamptz(input.StartedAt), EndedAt: timestamptz(input.EndedAt)})
	if errors.Is(err, pgx.ErrNoRows) {
		return rooms.Session{}, rooms.ErrRoomNotFound
	}
	if err != nil {
		return rooms.Session{}, err
	}
	session := mapCreateRoomSession(row)
	var metric webhookCommitMetric
	if session.Status == rooms.SessionStatusActive {
		snapshot := sessionWebhookSnapshot(session)
		metric, err = fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: input.TenantID, EventName: "session.started", SemanticKey: "session:" + session.ID.String() + ":started", ResourceType: "session", ResourceID: session.ID, OccurredAt: *session.StartedAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeSessionEvent(metadata, snapshot)
		}})
		if err != nil {
			return rooms.Session{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return rooms.Session{}, err
	}
	metric.Record(ctx)
	return session, nil
}

func roomChangedFields(before rooms.Room, input rooms.UpdateRoomInput) []string {
	result := []string{}
	if input.Name.Set && input.Name.Value != nil && *input.Name.Value != before.Name {
		result = append(result, "name")
	}
	if input.Status.Set && input.Status.Value != nil && *input.Status.Value != before.Status {
		result = append(result, "status")
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
func roomWebhookSnapshot(value rooms.Room) webhooks.RoomSnapshot {
	return webhooks.RoomSnapshot{ID: value.ID.String(), Name: value.Name, Slug: value.Slug, Status: value.Status, MediaPlane: value.MediaPlane, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}
func sessionWebhookSnapshot(value rooms.Session) webhooks.SessionSnapshot {
	return webhooks.SessionSnapshot{ID: value.ID.String(), RoomID: value.RoomID.String(), Status: value.Status, StartedAt: value.StartedAt, EndedAt: value.EndedAt, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}

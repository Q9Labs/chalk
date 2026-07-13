package postgres

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r WebhookRepository) Test(ctx context.Context, tenantID, endpointID utilities.ID, key string, metadata webhooks.EventMetadata) (webhooks.DeliveryResult, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if err := lockWebhookTenant(ctx, queries, tenantID); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	hash := idempotencyHash(struct{ Endpoint string }{endpointID.String()})
	if cached, ok, err := r.replayIdempotency(ctx, tx, tenantID, "endpoint.test", key, hash); err != nil {
		return webhooks.DeliveryResult{}, err
	} else if ok {
		return cached.Delivery.domain(), nil
	}
	endpoint, err := queries.GetWebhookEndpoint(ctx, sqlc.GetWebhookEndpointParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.DeliveryResult{}, webhooks.ErrEndpointNotFound
	}
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if !endpoint.Enabled {
		return webhooks.DeliveryResult{}, webhooks.ErrDeliveryNotRedeliverable
	}
	if metadata.ID.IsZero() || metadata.JourneyID.IsZero() {
		metadata, err = webhookEventMetadata(ctx, tenantID, "endpoint.test", time.Now().UTC())
		if err != nil {
			return webhooks.DeliveryResult{}, err
		}
	} else {
		metadata.TenantID = tenantID
		metadata.OccurredAt = time.Now().UTC().Truncate(time.Millisecond)
	}
	if metadata.ParentJourneyEventID.IsZero() {
		metadata.ParentJourneyEventID, err = utilities.NewID()
		if err != nil {
			return webhooks.DeliveryResult{}, err
		}
		if err := insertWebhookAPIRootJourneyEvent(ctx, tx, metadata.ParentJourneyEventID, metadata.JourneyID, "endpoint.test", metadata.ProducingTraceID, metadata.ProducingSpanID); err != nil {
			return webhooks.DeliveryResult{}, err
		}
	}
	body, digest, err := webhooks.EncodeTestEvent(metadata, endpointID)
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	event, err := queries.InsertWebhookEvent(ctx, sqlc.InsertWebhookEventParams{ID: uuid(metadata.ID), TenantID: uuid(tenantID), EventName: "endpoint.test", ApiVersion: webhooks.APIVersion, OccurredAt: timestamptz(&metadata.OccurredAt), Body: body, BodySha256: digest[:], SemanticTransitionKey: "endpoint.test:" + key, ResourceType: "webhook_endpoint", ResourceID: uuid(endpointID), JourneyID: uuid(metadata.JourneyID), ParentJourneyEventID: uuid(metadata.ParentJourneyEventID), ProducingTraceID: optionalText(metadata.ProducingTraceID), ProducingSpanID: optionalText(metadata.ProducingSpanID)})
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	deliveryID, err := utilities.NewID()
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	queuedID, err := utilities.NewID()
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	revisionID := endpointRevisionID(ctx, tx, tenantID, endpointID, endpoint.CurrentTargetRevision)
	if revisionID.IsZero() {
		return webhooks.DeliveryResult{}, webhooks.ErrEndpointNotFound
	}
	delivery, err := queries.InsertWebhookDelivery(ctx, sqlc.InsertWebhookDeliveryParams{ID: uuid(deliveryID), TenantID: uuid(tenantID), EventID: event.ID, EndpointID: uuid(endpointID), EndpointRevisionID: uuid(revisionID), EndpointRevision: endpoint.CurrentTargetRevision, NextAttemptAt: timestamptz(&metadata.OccurredAt), QueuedJourneyEventID: uuid(queuedID)})
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := insertWebhookJourneyEvent(ctx, tx, metadata.ID, metadata.JourneyID, 1, "webhook.event.committed", "committed", metadata.ParentJourneyEventID, metadata.ProducingTraceID, metadata.ProducingSpanID, map[string]any{"api_version": webhooks.APIVersion, "event_name": "endpoint.test"}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := insertWebhookJourneyEvent(ctx, tx, queuedID, metadata.JourneyID, 2, "webhook.delivery.queued", "queued", metadata.ID, "", "", map[string]any{"api_version": webhooks.APIVersion, "delivery_id": deliveryID.String(), "event_name": "endpoint.test"}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	result := deliveryResult(delivery)
	if err := insertWebhookAudit(ctx, tx, tenantID, "webhook_endpoint.test", "webhook_delivery", deliveryID, map[string]any{"endpoint_revision": result.EndpointRevision}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := r.storeIdempotency(ctx, tx, tenantID, "endpoint.test", key, hash, 201, deliveryID, webhookIdempotencyResponse{Delivery: cacheDelivery(result)}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	webhooks.RecordEventMetrics(ctx, "endpoint.test", webhooks.APIVersion, 1)
	return result, nil
}

func (r WebhookRepository) ListDeliveries(ctx context.Context, tenantID, endpointID utilities.ID, filters webhooks.DeliveryFilters, page pagination.PageRequest) (webhooks.DeliveryList, error) {
	params := sqlc.ListWebhookDeliveriesParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID), States: filters.States, EventTypes: filters.EventTypes, PageSize: int32(page.Size() + 1)}
	if cursor := page.Cursor(); cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = timestamptz(&cursor.CreatedAt)
		params.CursorID = uuid(cursor.ID)
	}
	rows, err := sqlc.New(r.pool).ListWebhookDeliveries(ctx, params)
	if err != nil {
		return webhooks.DeliveryList{}, err
	}
	hasMore := len(rows) > page.Size()
	if hasMore {
		rows = rows[:page.Size()]
	}
	list := webhooks.DeliveryList{Deliveries: make([]webhooks.Delivery, 0, len(rows)), Page: pagination.Page{PageSize: page.Size(), HasMore: hasMore}}
	for _, row := range rows {
		list.Deliveries = append(list.Deliveries, mapDeliveryRow(row))
	}
	if hasMore {
		last := list.Deliveries[len(list.Deliveries)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return list, nil
}

func (r WebhookRepository) GetDelivery(ctx context.Context, tenantID, endpointID, deliveryID utilities.ID) (webhooks.DeliveryDetail, error) {
	queries := sqlc.New(r.pool)
	row, err := queries.GetWebhookDelivery(ctx, sqlc.GetWebhookDeliveryParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID), DeliveryID: uuid(deliveryID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.DeliveryDetail{}, webhooks.ErrDeliveryNotFound
	}
	if err != nil {
		return webhooks.DeliveryDetail{}, err
	}
	if row.ErasedAt.Valid {
		return webhooks.DeliveryDetail{}, webhooks.ErrEventErased
	}
	attemptRows, err := queries.ListWebhookDeliveryAttempts(ctx, sqlc.ListWebhookDeliveryAttemptsParams{TenantID: uuid(tenantID), DeliveryID: uuid(deliveryID)})
	if err != nil {
		return webhooks.DeliveryDetail{}, err
	}
	attempts := make([]webhooks.Attempt, 0, len(attemptRows))
	for _, attempt := range attemptRows {
		attempts = append(attempts, mapAttempt(attempt))
	}
	return webhooks.DeliveryDetail{Delivery: mapDeliveryDetailRow(row), Event: append([]byte(nil), row.Body...), Attempts: attempts}, nil
}

func (r WebhookRepository) Redeliver(ctx context.Context, tenantID, endpointID, deliveryID utilities.ID, key string) (webhooks.DeliveryResult, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if err := lockWebhookTenant(ctx, queries, tenantID); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	hash := idempotencyHash(struct{ Endpoint, Delivery string }{endpointID.String(), deliveryID.String()})
	if cached, ok, err := r.replayIdempotency(ctx, tx, tenantID, "delivery.redeliver", key, hash); err != nil {
		return webhooks.DeliveryResult{}, err
	} else if ok {
		return cached.Delivery.domain(), nil
	}
	original, err := queries.GetWebhookDelivery(ctx, sqlc.GetWebhookDeliveryParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID), DeliveryID: uuid(deliveryID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhooks.DeliveryResult{}, webhooks.ErrDeliveryNotFound
	}
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if original.ErasedAt.Valid {
		return webhooks.DeliveryResult{}, webhooks.ErrEventErased
	}
	if timestamp(original.OccurredAt).Before(time.Now().UTC().Add(-30 * 24 * time.Hour)) {
		return webhooks.DeliveryResult{}, webhooks.ErrDeliveryNotRedeliverable
	}
	endpoint, err := queries.GetWebhookEndpoint(ctx, sqlc.GetWebhookEndpointParams{TenantID: uuid(tenantID), EndpointID: uuid(endpointID)})
	if err != nil {
		return webhooks.DeliveryResult{}, webhooks.ErrEndpointNotFound
	}
	if !endpoint.Enabled || int(original.ApiVersion) != int(endpoint.ApiVersion) || (original.State != "succeeded" && original.State != "exhausted") || !slices.Contains(endpoint.EventTypes, original.EventName) {
		return webhooks.DeliveryResult{}, webhooks.ErrDeliveryNotRedeliverable
	}
	newID, err := utilities.NewID()
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	queuedID, err := utilities.NewID()
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	revisionID := endpointRevisionID(ctx, tx, tenantID, endpointID, endpoint.CurrentTargetRevision)
	created, err := queries.InsertWebhookDelivery(ctx, sqlc.InsertWebhookDeliveryParams{ID: uuid(newID), TenantID: uuid(tenantID), EventID: original.EventID, EndpointID: uuid(endpointID), EndpointRevisionID: uuid(revisionID), EndpointRevision: endpoint.CurrentTargetRevision, NextAttemptAt: timestamptz(&now), QueuedJourneyEventID: uuid(queuedID), ParentDeliveryID: uuid(deliveryID)})
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	requested := time.Now().UTC()
	redeliveryMetadata, err := webhookEventMetadata(ctx, tenantID, "webhook.delivery.redelivery_requested", requested)
	if err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := insertWebhookOperationRoot(ctx, tx, redeliveryMetadata.ID, redeliveryMetadata.JourneyID, "webhook.delivery.redelivery_requested", redeliveryMetadata.ProducingTraceID, redeliveryMetadata.ProducingSpanID, map[string]any{"original_delivery_id": deliveryID.String(), "original_event_id": id(original.EventID).String(), "original_journey_id": id(original.JourneyID).String()}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := insertWebhookJourneyEvent(ctx, tx, queuedID, redeliveryMetadata.JourneyID, 1, "webhook.delivery.queued", "queued", redeliveryMetadata.ID, "", "", map[string]any{"api_version": webhooks.APIVersion, "delivery_id": newID.String(), "event_name": original.EventName}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	result := deliveryResult(created)
	if err := insertWebhookAudit(ctx, tx, tenantID, "webhook_delivery.redeliver", "webhook_delivery", newID, map[string]any{"endpoint_revision": result.EndpointRevision, "original_delivery_id": deliveryID.String()}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := r.storeIdempotency(ctx, tx, tenantID, "delivery.redeliver", key, hash, 201, newID, webhookIdempotencyResponse{Delivery: cacheDelivery(result)}); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return webhooks.DeliveryResult{}, err
	}
	return result, nil
}

func endpointRevisionID(ctx context.Context, tx pgx.Tx, tenantID, endpointID utilities.ID, revision int32) utilities.ID {
	var value pgtype.UUID
	err := tx.QueryRow(ctx, `select id from webhook_endpoint_revisions where tenant_id=$1 and endpoint_id=$2 and revision=$3`, uuid(tenantID), uuid(endpointID), revision).Scan(&value)
	if err != nil {
		return utilities.ID{}
	}
	return id(value)
}

func mapDeliveryRow(row sqlc.ListWebhookDeliveriesRow) webhooks.Delivery {
	return webhooks.Delivery{ID: id(row.ID), EventID: id(row.EventID), EventType: row.EventName, EndpointID: id(row.EndpointID), EndpointRevision: int(row.EndpointRevision), State: row.State, AttemptCount: int(row.AttemptCount), NextAttemptAt: nullableTimestamp(row.NextAttemptAt), TerminalAt: nullableTimestamp(row.TerminalAt), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)}
}
func mapDeliveryDetailRow(row sqlc.GetWebhookDeliveryRow) webhooks.Delivery {
	return webhooks.Delivery{ID: id(row.ID), EventID: id(row.EventID), EventType: row.EventName, EndpointID: id(row.EndpointID), EndpointRevision: int(row.EndpointRevision), State: row.State, AttemptCount: int(row.AttemptCount), NextAttemptAt: nullableTimestamp(row.NextAttemptAt), TerminalAt: nullableTimestamp(row.TerminalAt), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt)}
}
func mapAttempt(row sqlc.WebhookDeliveryAttempt) webhooks.Attempt {
	result := webhooks.Attempt{ID: id(row.ID), Number: int(row.AttemptNumber), StartedAt: timestamp(row.StartedAt), FinishedAt: nullableTimestamp(row.FinishedAt), Outcome: row.Outcome}
	if row.LatencyMilliseconds.Valid {
		value := int(row.LatencyMilliseconds.Int32)
		result.LatencyMilliseconds = &value
	}
	if row.HttpStatus.Valid {
		value := int(row.HttpStatus.Int32)
		result.HTTPStatus = &value
	}
	if row.ErrorCode.Valid {
		value := row.ErrorCode.String
		result.ErrorCode = &value
	}
	return result
}
func deliveryResult(row sqlc.WebhookDelivery) webhooks.DeliveryResult {
	return webhooks.DeliveryResult{EventID: id(row.EventID), DeliveryID: id(row.ID), EndpointID: id(row.EndpointID), EndpointRevision: int(row.EndpointRevision), State: row.State}
}

func optionalText(value string) pgtype.Text { return pgtype.Text{String: value, Valid: value != ""} }

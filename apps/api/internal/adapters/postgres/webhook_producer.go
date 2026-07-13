package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
	"go.opentelemetry.io/otel/trace"
)

type webhookProduction struct {
	TenantID                             utilities.ID
	EventName, SemanticKey, ResourceType string
	ResourceID, LinkedUserID             utilities.ID
	OccurredAt                           time.Time
	Body                                 func(webhooks.EventMetadata) ([]byte, [32]byte, error)
}

type webhookCommitMetric struct {
	EventName string
	Fanout    int
}

func (m webhookCommitMetric) Record(ctx context.Context) {
	if m.EventName != "" {
		webhooks.RecordEventMetrics(ctx, m.EventName, webhooks.APIVersion, m.Fanout)
	}
}

func fanoutWebhookEvent(ctx context.Context, tx pgx.Tx, production webhookProduction) (webhookCommitMetric, error) {
	queries := sqlc.New(tx)
	tenantID := production.TenantID
	if err := lockWebhookTenant(ctx, queries, tenantID); err != nil {
		return webhookCommitMetric{}, err
	}
	targets, err := queries.ListMatchingWebhookTargets(ctx, sqlc.ListMatchingWebhookTargetsParams{TenantID: uuid(tenantID), ApiVersion: webhooks.APIVersion, EventName: production.EventName})
	if err != nil || len(targets) == 0 {
		return webhookCommitMetric{}, err
	}
	metadata, err := webhookEventMetadata(ctx, tenantID, production.EventName, production.OccurredAt)
	if err != nil {
		return webhookCommitMetric{}, err
	}
	production.OccurredAt = metadata.OccurredAt
	body, digest, err := production.Body(metadata)
	if err != nil {
		return webhookCommitMetric{}, err
	}
	rootID, err := utilities.NewID()
	if err != nil {
		return webhookCommitMetric{}, err
	}
	metadata.ParentJourneyEventID = rootID
	event, err := queries.InsertWebhookEvent(ctx, sqlc.InsertWebhookEventParams{ID: uuid(metadata.ID), TenantID: uuid(tenantID), EventName: production.EventName, ApiVersion: webhooks.APIVersion, OccurredAt: timestamptz(&production.OccurredAt), Body: body, BodySha256: digest[:], SemanticTransitionKey: production.SemanticKey, ResourceType: production.ResourceType, ResourceID: uuid(production.ResourceID), LinkedUserID: uuid(production.LinkedUserID), JourneyID: uuid(metadata.JourneyID), ParentJourneyEventID: uuid(metadata.ParentJourneyEventID), ProducingTraceID: optionalText(metadata.ProducingTraceID), ProducingSpanID: optionalText(metadata.ProducingSpanID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return webhookCommitMetric{}, nil
	}
	if err != nil {
		return webhookCommitMetric{}, err
	}
	if err := insertWebhookAPIRootJourneyEvent(ctx, tx, rootID, metadata.JourneyID, production.EventName, metadata.ProducingTraceID, metadata.ProducingSpanID); err != nil {
		return webhookCommitMetric{}, err
	}
	if err := insertWebhookJourneyEvent(ctx, tx, metadata.ID, metadata.JourneyID, 1, "webhook.event.committed", "committed", metadata.ParentJourneyEventID, metadata.ProducingTraceID, metadata.ProducingSpanID, map[string]any{"api_version": webhooks.APIVersion, "event_name": production.EventName}); err != nil {
		return webhookCommitMetric{}, err
	}
	for _, target := range targets {
		deliveryID, idErr := utilities.NewID()
		if idErr != nil {
			return webhookCommitMetric{}, idErr
		}
		queuedID, idErr := utilities.NewID()
		if idErr != nil {
			return webhookCommitMetric{}, idErr
		}
		_, err = queries.InsertWebhookDelivery(ctx, sqlc.InsertWebhookDeliveryParams{ID: uuid(deliveryID), TenantID: uuid(tenantID), EventID: event.ID, EndpointID: target.EndpointID, EndpointRevisionID: target.EndpointRevisionID, EndpointRevision: target.Revision, NextAttemptAt: timestamptz(&production.OccurredAt), QueuedJourneyEventID: uuid(queuedID)})
		if err != nil {
			return webhookCommitMetric{}, err
		}
		if err := insertWebhookJourneyEvent(ctx, tx, queuedID, metadata.JourneyID, 2, "webhook.delivery.queued", "queued", metadata.ID, "", "", map[string]any{"api_version": webhooks.APIVersion, "delivery_id": deliveryID.String(), "event_name": production.EventName}); err != nil {
			return webhookCommitMetric{}, err
		}
	}
	return webhookCommitMetric{EventName: production.EventName, Fanout: len(targets)}, nil
}

func webhookEventMetadata(ctx context.Context, tenantID utilities.ID, name string, occurredAt time.Time) (webhooks.EventMetadata, error) {
	occurredAt = occurredAt.UTC().Truncate(time.Millisecond)
	eventID, err := utilities.NewID()
	if err != nil {
		return webhooks.EventMetadata{}, err
	}
	journeyID, ok := observability.JourneyIDFromContext(ctx)
	if !ok {
		journeyID, err = utilities.NewID()
		if err != nil {
			return webhooks.EventMetadata{}, err
		}
	}
	metadata := webhooks.EventMetadata{ID: eventID, TenantID: tenantID, Name: name, OccurredAt: occurredAt, JourneyID: journeyID}
	span := trace.SpanContextFromContext(ctx)
	if span.IsValid() {
		metadata.ProducingTraceID = span.TraceID().String()
		metadata.ProducingSpanID = span.SpanID().String()
	}
	return metadata, nil
}

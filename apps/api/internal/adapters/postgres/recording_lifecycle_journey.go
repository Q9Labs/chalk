package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

type recordingLifecycleJourney struct {
	ID            utilities.ID
	ParentEventID utilities.ID
}

func recordingLifecycleJourneyFromContext(ctx context.Context) (recordingLifecycleJourney, error) {
	if journeyID, ok := observability.JourneyIDFromContext(ctx); ok {
		parentEventID, err := utilities.NewID()
		if err != nil {
			return recordingLifecycleJourney{}, fmt.Errorf("generate recording capture lifecycle journey event id: %w", err)
		}
		return recordingLifecycleJourney{ID: journeyID, ParentEventID: parentEventID}, nil
	}
	journeyID, err := utilities.NewID()
	if err != nil {
		return recordingLifecycleJourney{}, fmt.Errorf("generate recording capture lifecycle journey id: %w", err)
	}
	parentEventID, err := utilities.NewID()
	if err != nil {
		return recordingLifecycleJourney{}, fmt.Errorf("generate recording capture lifecycle journey event id: %w", err)
	}
	return recordingLifecycleJourney{ID: journeyID, ParentEventID: parentEventID}, nil
}

type recordingLifecycleJourneyAttributes struct {
	OperationName  string    `json:"operation_name"`
	CaptureAttempt int       `json:"capture_attempt"`
	ObservedAt     time.Time `json:"observed_at"`
	NoPublisher    *bool     `json:"no_publisher,omitempty"`
}

func persistRecordingLifecycleJourneyRoot(ctx context.Context, transaction pgx.Tx, journey recordingLifecycleJourney, operationName string, attempt int, observedAt time.Time, noPublisher bool) error {
	attributes := recordingLifecycleJourneyAttributes{OperationName: operationName, CaptureAttempt: attempt, ObservedAt: observedAt.UTC()}
	if operationName == recordingCaptureReadyOperation {
		attributes.NoPublisher = &noPublisher
	}
	encoded, err := json.Marshal(attributes)
	if err != nil {
		return fmt.Errorf("marshal recording capture lifecycle journey attributes: %w", err)
	}
	traceID, spanID, _, _ := lifecycleTraceContext(ctx)
	_, err = transaction.Exec(ctx, `insert into observability_journey_events(event_id, journey_id, sequence, occurred_at, name, phase, state, origin_kind, first_observed_layer, upstream_visibility, trace_id, span_id, attributes) values($1, $2, 0, now(), $3, 'capture_callback', 'accepted', 'worker', 'api', 'visible', $4, $5, $6)`, uuid(journey.ParentEventID), uuid(journey.ID), operationName, optionalText(traceID), optionalText(spanID), encoded)
	if err != nil {
		return recordingLifecycleRepositoryError("persist journey root", err)
	}
	return nil
}

func lifecycleTraceContext(ctx context.Context) (string, string, string, string) {
	span := trace.SpanContextFromContext(ctx)
	if !span.IsValid() {
		return "", "", "", ""
	}
	traceID, spanID := span.TraceID().String(), span.SpanID().String()
	traceparent := fmt.Sprintf("00-%s-%s-%02x", traceID, spanID, byte(span.TraceFlags()))
	return traceID, spanID, traceparent, span.TraceState().String()
}

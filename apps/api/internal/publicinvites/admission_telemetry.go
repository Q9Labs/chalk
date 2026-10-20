package publicinvites

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

var admissionOutcomes, _ = otel.Meter("chalk.public_invite").Int64Counter("chalk.public_invite.admission.outcomes")

func recordAdmissionOutcome(ctx context.Context, arrival Arrival, reason string) {
	attributes := []attribute.KeyValue{attribute.String("state", string(arrival.State)), attribute.String("reason", reason)}
	admissionOutcomes.Add(ctx, 1, metric.WithAttributes(attributes...))
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("chalk.public_invite.admission.state", string(arrival.State)), attribute.String("chalk.public_invite.admission.reason", reason))
	slog.InfoContext(ctx, "public admission completed", "event", "public_invite.admission", "state", arrival.State, "reason", reason,
		"tenant_id", arrival.TenantID.String(), "space_id", arrival.SpaceID.String(), "arrival_handle", arrival.ArrivalHandle.String())
}

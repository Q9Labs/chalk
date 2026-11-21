package publicinvites

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/obs"
)

type clientSessionContextKey struct{}

// WithClientSessionID carries the visitor's pre-auth cs_ on the request context so API-side
// admission decisions can name the same session the entry records use.
func WithClientSessionID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, clientSessionContextKey{}, id)
}

func ClientSessionIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(clientSessionContextKey{}).(string)
	return id
}

var admissionOutcomes, _ = otel.Meter("chalk.public_invite").Int64Counter("chalk.public_invite.admission.outcomes")

// RecordAdmissionOutcome records a committed terminal admission result.
func RecordAdmissionOutcome(ctx context.Context, arrival Arrival, reason string) {
	attributes := []attribute.KeyValue{attribute.String("state", string(arrival.State)), attribute.String("reason", reason)}
	admissionOutcomes.Add(ctx, 1, metric.WithAttributes(attributes...))
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("chalk.public_invite.admission.state", string(arrival.State)), attribute.String("chalk.public_invite.admission.reason", reason))
	slog.InfoContext(ctx, "public admission completed", "event", "public_invite.admission", "state", string(arrival.State), "reason", reason,
		"tenant_id", arrival.TenantID.String(), "space_id", arrival.SpaceID.String(), "arrival_handle", arrival.ArrivalHandle.String())
	// The admission.outcome decision is the terminal record a diagnosis asks for; the counter and log above keep their
	// existing roles alongside it.
	decision := "completed"
	if arrival.State == ArrivalAdmitted {
		decision = "admitted"
	}
	obs.Decision(ctx, obs.EventAdmissionOutcome, decision, reason,
		obs.F("arrival_handle", arrival.ArrivalHandle.String()),
		obs.F("space_id", arrival.SpaceID.String()),
		obs.F("tenant_id", arrival.TenantID.String()),
		obs.F("client_session_id", ClientSessionIDFrom(ctx)))
}

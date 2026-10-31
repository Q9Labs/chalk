package observability

import (
	"context"
	"regexp"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/sdk/trace"
)

// SessionIDKey is the OpenTelemetry attribute and W3C baggage member that carry
// the client session: one run of a Chalk app on one device. It is unrelated to
// Episodes and to provider or dashboard login sessions.
const SessionIDKey = "session.id"

var sessionIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// SessionIDFromContext returns the session ID the client sent in `baggage`.
// The otelhttp server middleware extracts the header into the context; values
// that are not a lowercase UUID are ignored so clients cannot inject free text
// into spans or logs.
func SessionIDFromContext(ctx context.Context) (string, bool) {
	value := baggage.FromContext(ctx).Member(SessionIDKey).Value()
	return value, sessionIDPattern.MatchString(value)
}

// sessionSpanProcessor copies the session ID onto every span started under a
// request, including database and provider spans, not only the server span.
type sessionSpanProcessor struct{}

func (sessionSpanProcessor) OnStart(ctx context.Context, span trace.ReadWriteSpan) {
	if sessionID, ok := SessionIDFromContext(ctx); ok {
		span.SetAttributes(attribute.String(SessionIDKey, sessionID))
	}
}

func (sessionSpanProcessor) OnEnd(trace.ReadOnlySpan)         {}
func (sessionSpanProcessor) Shutdown(context.Context) error   { return nil }
func (sessionSpanProcessor) ForceFlush(context.Context) error { return nil }

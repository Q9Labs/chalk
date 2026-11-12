package observability

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type serverSpanKey struct{}

// TenantIDKey is the span attribute for the tenant a request belongs to.
const TenantIDKey = "tenant.id"

// requestTenantID returns the tenant from the matched route's {tenant_id}
// parameter. Only a valid ID counts, so path text never reaches a span or log.
func requestTenantID(ctx context.Context) string {
	routeContext := chi.RouteContext(ctx)
	if routeContext == nil {
		return ""
	}
	tenantID, err := utilities.ParseID(routeContext.URLParam("tenant_id"))
	if err != nil {
		return ""
	}
	return tenantID.String()
}

// tagRequestSpans puts the matched route pattern and the tenant on the server
// span and on the journey span, so route latency can be queried. The route is
// known only after dispatch; an unmatched request gets no route, as the OpenTelemetry
// convention asks.
func tagRequestSpans(ctx context.Context, route string) {
	attributes := make([]attribute.KeyValue, 0, 2)
	if route != "unmatched" {
		attributes = append(attributes, semconv.HTTPRoute(route))
	}
	if tenantID := requestTenantID(ctx); tenantID != "" {
		attributes = append(attributes, attribute.String(TenantIDKey, tenantID))
	}
	if len(attributes) == 0 {
		return
	}
	if server, ok := ctx.Value(serverSpanKey{}).(trace.Span); ok {
		server.SetAttributes(attributes...)
	}
	trace.SpanFromContext(ctx).SetAttributes(attributes...)
}

// keepServerSpan lets later middleware reach the otelhttp server span, which is
// the current span only until the journey middleware starts its own.
func keepServerSpan(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), serverSpanKey{}, trace.SpanFromContext(r.Context()))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

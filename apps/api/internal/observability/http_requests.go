package observability

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// requestCounter counts every HTTP request in chalk.api.http.requests, by matched route and
// status class. The count is the denominator for the failures the request log keeps: it holds
// whatever the log mode drops, at a cost bounded by the number of routes.
type requestCounter struct {
	requests otelmetric.Int64Counter
}

func newRequestCounter() requestCounter {
	requests, _ := otel.Meter("github.com/q9labs/chalk/apps/api/internal/observability").Int64Counter(
		"chalk.api.http.requests",
		otelmetric.WithDescription("HTTP requests by matched route and status class, whatever the request log keeps"),
		otelmetric.WithUnit("{request}"),
	)
	return requestCounter{requests: requests}
}

func (c requestCounter) count(ctx context.Context, route string, status int) {
	c.requests.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("route", route), attribute.String("status_class", statusClass(status))))
}

func statusClass(status int) string {
	switch {
	case status >= 500:
		return "5xx"
	case status >= 400:
		return "4xx"
	case status >= 300:
		return "3xx"
	case status >= 200:
		return "2xx"
	default:
		return "1xx"
	}
}

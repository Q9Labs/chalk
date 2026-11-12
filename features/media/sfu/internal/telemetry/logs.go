package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// NewLogger returns the node's logger. Every record goes to local, and over OTLP/HTTP to the store
// the API's logs go to when an endpoint is configured, so one query by Episode id reads both sides.
// The exporter reads its token and dataset from OTEL_EXPORTER_OTLP_LOGS_HEADERS. The returned
// function sends the last records and stops the exporter.
func NewLogger(ctx context.Context, cfg config.Telemetry, local slog.Handler) (*slog.Logger, func(context.Context) error, error) {
	// Without a token the store would refuse every batch, so the node logs locally only.
	if cfg.OTLPEndpoint == "" || os.Getenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS") == "" {
		return slog.New(local), func(context.Context) error { return nil }, nil
	}
	options := []otlploghttp.Option{otlploghttp.WithEndpointURL(logsURL(cfg.OTLPEndpoint))}
	if cfg.OTLPInsecure {
		options = append(options, otlploghttp.WithInsecure())
	}
	exporter, err := otlploghttp.New(ctx, options...)
	if err != nil {
		return nil, nil, fmt.Errorf("create OTLP log exporter: %w", err)
	}
	attributes, err := resource.New(ctx, resource.WithAttributes(
		semconv.ServiceName("chalk-sfu"),
		semconv.ServiceVersion(cfg.Version),
		semconv.DeploymentEnvironmentName(cfg.Environment),
	))
	if err != nil {
		return nil, nil, fmt.Errorf("create log resource: %w", err)
	}
	provider := sdklog.NewLoggerProvider(sdklog.WithResource(attributes), sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)))
	remote := otelslog.NewHandler(scope, otelslog.WithLoggerProvider(provider), otelslog.WithVersion(cfg.Version))
	return slog.New(fanout{local, remote}), provider.Shutdown, nil
}

func logsURL(endpoint string) string {
	parsed, err := url.Parse(strings.TrimRight(endpoint, "/"))
	if err != nil {
		return endpoint
	}
	parsed.Path = "/v1/logs"
	return parsed.String()
}

// fanout writes each record to every handler that wants it. A failing handler does not keep the
// others from the record.
type fanout []slog.Handler

func (f fanout) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range f {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (f fanout) Handle(ctx context.Context, record slog.Record) error {
	var first error
	for _, handler := range f {
		if !handler.Enabled(ctx, record.Level) {
			continue
		}
		if err := handler.Handle(ctx, record.Clone()); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (f fanout) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make(fanout, len(f))
	for index, handler := range f {
		next[index] = handler.WithAttrs(attrs)
	}
	return next
}

func (f fanout) WithGroup(name string) slog.Handler {
	next := make(fanout, len(f))
	for index, handler := range f {
		next[index] = handler.WithGroup(name)
	}
	return next
}

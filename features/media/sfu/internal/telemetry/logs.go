package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync/atomic"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// NewLogger returns the node's logger. Every record goes to local. When an endpoint is configured,
// the diagnosis trail also goes over OTLP/HTTP to the store the API's logs go to, so one query by
// Episode id reads both sides. Only the events in exportedEvents leave, with their listed fields.
// The exporter reads its token and dataset from OTEL_EXPORTER_OTLP_LOGS_HEADERS. The returned
// function sends the last records and stops the exporter. The Diagnostics say whether the export
// runs and count what it loses. Without a token the store would refuse every batch, so the node
// logs locally only, and the Diagnostics say so: the caller must make that visible.
func NewLogger(ctx context.Context, cfg config.Telemetry, instance string, local slog.Handler) (*slog.Logger, *Diagnostics, func(context.Context) error, error) {
	diag := &Diagnostics{}
	if cfg.OTLPEndpoint == "" || os.Getenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS") == "" {
		return slog.New(local), diag, func(context.Context) error { return nil }, nil
	}
	options := []otlploghttp.Option{otlploghttp.WithEndpointURL(logsURL(cfg.OTLPEndpoint))}
	if cfg.OTLPInsecure {
		options = append(options, otlploghttp.WithInsecure())
	}
	exporter, err := otlploghttp.New(ctx, options...)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create OTLP log exporter: %w", err)
	}
	attributes, err := fixedResource(ctx,
		semconv.ServiceName("chalk-sfu"),
		semconv.ServiceVersion(cfg.Version),
		semconv.ServiceInstanceID(instance),
		semconv.DeploymentEnvironmentName(cfg.Environment),
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create log resource: %w", err)
	}
	var held atomic.Int64
	batch := sdklog.NewBatchProcessor(countingExporter{Exporter: exporter, held: &held, diag: diag}, sdklog.WithMaxQueueSize(2*exportQueueLimit))
	provider := sdklog.NewLoggerProvider(sdklog.WithResource(attributes), sdklog.WithProcessor(boundedProcessor{BatchProcessor: batch, held: &held, diag: diag}))
	remote := otelslog.NewHandler(scope, otelslog.WithLoggerProvider(provider), otelslog.WithVersion(cfg.Version))
	diag.logsExport.Store(true)
	return slog.New(fanout{local, newExportOnly(remote, diag)}), diag, provider.Shutdown, nil
}

// fixedResource builds the node's resource from the given attributes and nothing else. The SDK
// merges OTEL_RESOURCE_ATTRIBUTES into the resource of every provider, which would send whatever
// that variable holds outside the allowlist, so the variable is cleared before a provider is built.
// Call it while the node starts, before other goroutines read the environment.
func fixedResource(ctx context.Context, attrs ...attribute.KeyValue) (*resource.Resource, error) {
	if err := os.Unsetenv("OTEL_RESOURCE_ATTRIBUTES"); err != nil {
		return nil, fmt.Errorf("clear OTEL_RESOURCE_ATTRIBUTES: %w", err)
	}
	return resource.New(ctx, resource.WithAttributes(attrs...))
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

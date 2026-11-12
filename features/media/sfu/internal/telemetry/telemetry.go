// Package telemetry exports the node's metrics over OTLP/HTTP, the pipeline the API uses. Every
// instrument is asynchronous: one callback reads the node's latest control-loop tick at export
// time, so the packet path pays nothing for export. No metric carries a Tenant, Episode,
// Participant, session or address; attributes come from closed sets.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

// scope names the meter, as the API names its meters by package path.
const scope = "github.com/q9labs/chalk/features/media/sfu/internal/telemetry"

// Read returns the node's telemetry at one moment.
type Read func() media.Telemetry

// Exporter sends the node's metrics on an interval until it shuts down.
type Exporter struct {
	provider *sdkmetric.MeterProvider
}

// Start exports the node's metrics when an endpoint is configured, and returns a no-op exporter
// otherwise. instance names this process boot, the node's incarnation.
func Start(ctx context.Context, cfg config.Telemetry, instance string, read Read, log *slog.Logger) (*Exporter, error) {
	if cfg.OTLPEndpoint == "" {
		log.Info("telemetry export off: SFU_OTLP_ENDPOINT is not set")
		return &Exporter{}, nil
	}
	options := []otlpmetrichttp.Option{otlpmetrichttp.WithEndpointURL(metricsURL(cfg.OTLPEndpoint))}
	if cfg.OTLPInsecure {
		options = append(options, otlpmetrichttp.WithInsecure())
	}
	exporter, err := otlpmetrichttp.New(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("create OTLP metric exporter: %w", err)
	}
	attributes, err := fixedResource(ctx,
		semconv.ServiceName("chalk-sfu"),
		semconv.ServiceVersion(cfg.Version),
		semconv.ServiceInstanceID(instance),
		semconv.DeploymentEnvironmentName(cfg.Environment),
	)
	if err != nil {
		return nil, fmt.Errorf("create telemetry resource: %w", err)
	}
	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(attributes),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(cfg.Interval))),
	)
	// A failed export retries on the next interval; the log names it so an operator sees a gap.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) { log.Warn("telemetry export failed", "error", err) }))
	if err := Register(provider.Meter(scope), read); err != nil {
		return nil, errors.Join(err, provider.Shutdown(ctx))
	}
	log.Info("telemetry export on", "interval", cfg.Interval.String())
	return &Exporter{provider: provider}, nil
}

// Shutdown sends the last metrics and stops the exporter.
func (e *Exporter) Shutdown(ctx context.Context) error {
	if e.provider == nil {
		return nil
	}
	return e.provider.Shutdown(ctx)
}

func metricsURL(endpoint string) string {
	parsed, err := url.Parse(strings.TrimRight(endpoint, "/"))
	if err != nil {
		return endpoint
	}
	parsed.Path = "/v1/metrics"
	return parsed.String()
}

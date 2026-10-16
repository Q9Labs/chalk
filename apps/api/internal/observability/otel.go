package observability

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	logglobal "go.opentelemetry.io/otel/log/global"
	lognoop "go.opentelemetry.io/otel/log/noop"

	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

const journeyHeader = "x-chalk-journey-id"

var runtimeMetricsOnce sync.Once

type Runtime struct {
	shutdown func(context.Context) error
}

func Start(ctx context.Context, config Config) (Runtime, error) {
	propagator := propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{})
	endpoint := strings.TrimSpace(config.OTLPEndpoint)
	if endpoint == "" {
		otel.SetTracerProvider(tracenoop.NewTracerProvider())
		otel.SetMeterProvider(metricnoop.NewMeterProvider())
		logglobal.SetLoggerProvider(lognoop.NewLoggerProvider())
		otel.SetTextMapPropagator(propagator)
		return Runtime{}, nil
	}

	resource, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(valueOrDefault(config.Service, "chalk-api")),
			semconv.ServiceVersion(valueOrDefault(config.Version, "dev")),
			semconv.DeploymentEnvironmentName(valueOrDefault(config.Environment, "local")),
		),
	)
	if err != nil {
		return Runtime{}, fmt.Errorf("create telemetry resource: %w", err)
	}

	traceOptions := []trace.TracerProviderOption{trace.WithResource(resource), trace.WithSampler(trace.ParentBased(trace.AlwaysSample()))}
	meterOptions := []sdkmetric.Option{sdkmetric.WithResource(resource)}
	logOptions := []sdklog.LoggerProviderOption{sdklog.WithResource(resource)}
	traceExporter, err := otlptracehttp.New(ctx, otlpHTTPOptions(endpoint, config.OTLPInsecure)...)
	if err != nil {
		return Runtime{}, fmt.Errorf("create OTLP trace exporter: %w", err)
	}
	metricExporter, err := otlpmetrichttp.New(ctx, otlpMetricHTTPOptions(endpoint, config.OTLPInsecure)...)
	if err != nil {
		return Runtime{}, fmt.Errorf("create OTLP metric exporter: %w", err)
	}
	logExporter, err := otlploghttp.New(ctx, otlpLogHTTPOptions(endpoint, config.OTLPInsecure)...)
	if err != nil {
		return Runtime{}, fmt.Errorf("create OTLP log exporter: %w", err)
	}
	traceOptions = append(traceOptions, trace.WithBatcher(traceExporter))
	meterOptions = append(meterOptions, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter)))
	logOptions = append(logOptions, sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)))

	traceProvider := trace.NewTracerProvider(traceOptions...)
	meterProvider := sdkmetric.NewMeterProvider(meterOptions...)
	logProvider := sdklog.NewLoggerProvider(logOptions...)
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(meterProvider)
	logglobal.SetLoggerProvider(logProvider)
	otel.SetTextMapPropagator(propagator)
	runtimeMetricsOnce.Do(func() { runtime.Start(runtime.WithMeterProvider(meterProvider)) })

	return Runtime{shutdown: func(shutdownCtx context.Context) error {
		traceErr := traceProvider.Shutdown(shutdownCtx)
		metricErr := meterProvider.Shutdown(shutdownCtx)
		logErr := logProvider.Shutdown(shutdownCtx)
		if traceErr != nil {
			return fmt.Errorf("shutdown trace provider: %w", traceErr)
		}
		if metricErr != nil {
			return fmt.Errorf("shutdown metric provider: %w", metricErr)
		}
		if logErr != nil {
			return fmt.Errorf("shutdown log provider: %w", logErr)
		}
		return nil
	}}, nil
}

func otlpLogHTTPOptions(endpoint string, insecure bool) []otlploghttp.Option {
	options := []otlploghttp.Option{otlploghttp.WithEndpointURL(otlpEndpointURL(endpoint, "/v1/logs"))}
	if insecure {
		options = append(options, otlploghttp.WithInsecure())
	}
	return options
}

func (r Runtime) Shutdown(ctx context.Context) error {
	if r.shutdown == nil {
		return nil
	}
	return r.shutdown(ctx)
}

func OTelHTTPMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, "http.server.request")
	}
}

func otlpHTTPOptions(endpoint string, insecure bool) []otlptracehttp.Option {
	options := []otlptracehttp.Option{otlptracehttp.WithEndpointURL(otlpEndpointURL(endpoint, "/v1/traces"))}
	if insecure {
		options = append(options, otlptracehttp.WithInsecure())
	}
	return options
}

func otlpMetricHTTPOptions(endpoint string, insecure bool) []otlpmetrichttp.Option {
	options := []otlpmetrichttp.Option{otlpmetrichttp.WithEndpointURL(otlpEndpointURL(endpoint, "/v1/metrics"))}
	if insecure {
		options = append(options, otlpmetrichttp.WithInsecure())
	}
	return options
}

func otlpEndpointURL(endpoint string, path string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	parsed.Path = path
	return parsed.String()
}

func TelemetryShutdownContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

func journeyAttribute(journeyID string) attribute.KeyValue {
	return attribute.String("chalk.journey.id", journeyID)
}

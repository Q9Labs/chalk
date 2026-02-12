package otel

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/Q9Labs/chalk/internal/version"
	"github.com/axiomhq/axiom-go/axiom"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

var tracerProvider *sdktrace.TracerProvider

type Config struct {
	AxiomDomain      string
	AxiomToken       string
	TracesDataset    string
	Env              string
	Region           string
	SamplerRatio     float64
	ServiceName      string
	ServiceNamespace string
}

func Init(ctx context.Context) {
	cfg := loadConfig()
	if cfg.AxiomToken == "" || cfg.TracesDataset == "" || cfg.AxiomDomain == "" {
		// Tracing disabled (intentionally silent).
		otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample())))
		return
	}

	// Guardrail: disable exporter if dataset doesn't exist/unauthorized to avoid retry spam.
	if ok := verifyDataset(ctx, cfg.AxiomToken, cfg.TracesDataset); !ok {
		otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample())))
		return
	}

	res, _ := sdkresource.Merge(
		sdkresource.Default(),
		sdkresource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(version.Version),
			attribute.String("deployment.environment.name", cfg.Env),
			semconv.CloudRegion(cfg.Region),
			attribute.String("git.commit.sha", version.CommitSHA),
		),
	)

	exp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(cfg.AxiomDomain),
		otlptracehttp.WithURLPath("/v1/traces"),
		otlptracehttp.WithHeaders(map[string]string{
			"Authorization":   "Bearer " + cfg.AxiomToken,
			"X-Axiom-Dataset": cfg.TracesDataset,
		}),
	)
	if err != nil {
		slog.Error("otel trace exporter init failed; disabling tracing", "error", err)
		otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample())))
		return
	}

	tracerProvider = sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithBatcher(exp),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SamplerRatio))),
	)

	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	otel.SetTracerProvider(tracerProvider)

	slog.Info("otel tracing enabled",
		"dataset", cfg.TracesDataset,
		"sampler_ratio", cfg.SamplerRatio,
	)
}

func Shutdown(ctx context.Context) {
	if tracerProvider == nil {
		return
	}
	_ = tracerProvider.Shutdown(ctx)
}

func loadConfig() Config {
	env := getEnv("ENV", "development")
	return Config{
		AxiomDomain:   getEnv("AXIOM_DOMAIN", ""),
		AxiomToken:    getEnv("AXIOM_TOKEN", ""),
		TracesDataset: getEnv("AXIOM_TRACES_DATASET", ""),
		Env:           env,
		Region:        getEnv("AWS_REGION", "unknown"),
		SamplerRatio:  getEnvFloat("OTEL_TRACE_SAMPLER_RATIO", 0.1),
		ServiceName:   "chalk-api",
	}
}

func verifyDataset(ctx context.Context, token, dataset string) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	client, err := axiom.NewClient(axiom.SetToken(token))
	if err != nil {
		slog.Error("otel: failed to init axiom client for dataset verify", "error", err)
		return false
	}
	_, err = client.Datasets.Get(ctx, dataset)
	if err == nil {
		return true
	}
	if errors.Is(err, axiom.ErrNotFound) {
		slog.Error("otel traces dataset not found; disabling tracing", "dataset", dataset)
		return false
	}
	if errors.Is(err, axiom.ErrUnauthorized) || errors.Is(err, axiom.ErrUnauthenticated) {
		slog.Error("otel axiom auth failed; disabling tracing", "dataset", dataset, "error", err)
		return false
	}
	slog.Error("otel dataset verify failed; disabling tracing", "dataset", dataset, "error", err)
	return false
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvFloat(key string, fallback float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 && f <= 1 {
			return f
		}
	}
	return fallback
}

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type commandResources struct {
	repository postgres.RecordingPipelineRepository
	store      r2.Store
	tracer     trace.Tracer
	pool       *pgxpool.Pool
	telemetry  func(io.Writer)
}

type commandRuntime struct {
	commandResources
	ctx       context.Context
	batchSpan trace.Span
}

func openCommandRuntime(ctx context.Context, apply bool, stderr io.Writer) (commandRuntime, error) {
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		return commandRuntime{}, errors.New("CHALK_DATABASE_URL required")
	}
	telemetry, err := startRearmTelemetry(ctx)
	if err != nil {
		return commandRuntime{}, err
	}
	tracer := otel.Tracer("github.com/q9labs/chalk/apps/api/cmd/recording-transcription-rearm")
	spanCtx, batchSpan := tracer.Start(ctx, "recording.transcription.rearm", trace.WithAttributes(attribute.String("chalk.journey.id", rearmJourneyID(ctx).String())))
	fail := func(err error) (commandRuntime, error) {
		batchSpan.End()
		telemetry(stderr)
		return commandRuntime{}, err
	}
	pool, err := openRearmDatabase(spanCtx, apply, url)
	if err != nil {
		return fail(err)
	}
	store, err := openRearmObjectStore()
	if err != nil {
		pool.Close()
		return fail(err)
	}
	return commandRuntime{
		commandResources: commandResources{
			repository: postgres.NewRecordingPipelineRepositoryWithPool(pool), store: store,
			tracer: tracer, pool: pool, telemetry: telemetry,
		},
		ctx: spanCtx, batchSpan: batchSpan,
	}, nil
}

func (runtime commandRuntime) close(stderr io.Writer) {
	runtime.pool.Close()
	runtime.batchSpan.End()
	runtime.telemetry(stderr)
}

func startRearmTelemetry(ctx context.Context) (func(io.Writer), error) {
	endpoint := strings.TrimSpace(os.Getenv(config.APIOTLPEndpoint))
	telemetry, err := observability.Start(ctx, observability.Config{
		Environment: os.Getenv(config.APIEnvironment), Service: "chalk-recording-transcription-rearm", Version: os.Getenv(config.APIVersion),
		OTLPEndpoint: endpoint, OTLPInsecure: strings.EqualFold(os.Getenv(config.APIOTLPInsecure), "true"),
	})
	if err != nil {
		return nil, fmt.Errorf("start re-arm telemetry: %w", err)
	}
	shutdown := telemetry.Shutdown
	if endpoint == "" {
		provider := sdktrace.NewTracerProvider()
		otel.SetTracerProvider(provider)
		shutdown = provider.Shutdown
	}
	return func(stderr io.Writer) {
		shutdownCtx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		if err := shutdown(shutdownCtx); err != nil {
			fmt.Fprintln(stderr, "recording-transcription-rearm: warning: telemetry shutdown:", err)
		}
	}, nil
}

func openRearmDatabase(ctx context.Context, apply bool, url string) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}
	if !apply {
		poolConfig.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, errors.New("open re-arm database")
	}
	return pool, nil
}

func openRearmObjectStore() (r2.Store, error) {
	store, err := r2.NewStore(config.R2Config{
		AccessKeyID: os.Getenv(config.R2AccessKeyID), SecretAccessKey: os.Getenv(config.R2SecretAccessKey),
		AccountID: os.Getenv(config.R2AccountID), Bucket: os.Getenv(config.R2Bucket),
		Endpoint: os.Getenv(config.R2Endpoint), RequestTimeout: 10 * time.Second,
	})
	if err != nil {
		return r2.Store{}, errors.New("invalid object storage configuration")
	}
	return store, nil
}

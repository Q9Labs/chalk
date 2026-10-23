// recording-backfill inventories retained successful captures. It is read-only unless --apply is explicit.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type report struct {
	DryRun           bool   `json:"dry_run"`
	Inspected        int    `json:"inspected"`
	Recoverable      int    `json:"recoverable"`
	AlreadyQueued    int    `json:"already_queued"`
	Expired          int    `json:"expired"`
	NoLongerEligible int    `json:"no_longer_eligible"`
	MissingSource    int    `json:"missing_source"`
	Unverifiable     int    `json:"unverifiable"`
	Queued           int    `json:"queued"`
	NextAfter        string `json:"next_after_recording,omitempty"`
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "recording-backfill:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out io.Writer) (runErr error) {
	flags := flag.NewFlagSet("recording-backfill", flag.ContinueOnError)
	batchSize := flags.Int("batch-size", 0, "required: inspect at most 1-100 captures")
	apply := flags.Bool("apply", false, "queue verified captures; default is a read-only dry run")
	after := flags.String("after-recording", "", "continue after the previous report's cursor")
	limit := flags.Duration("timeout", 15*time.Minute, "whole-command deadline, at most 20 minutes")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *batchSize < 1 || *batchSize > 100 || *limit <= 0 || *limit > 20*time.Minute {
		return errors.New("explicit --batch-size (1-100) and --timeout (0-20m) required; no positional arguments")
	}
	var cursor pgtype.UUID
	if *after != "" {
		id, err := utilities.ParseID(*after)
		if err != nil {
			return errors.New("invalid --after-recording cursor")
		}
		cursor = pgtype.UUID{Bytes: id.Bytes(), Valid: true}
	}
	ctx, cancel := context.WithTimeout(ctx, *limit)
	defer cancel()
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		return errors.New("CHALK_DATABASE_URL required")
	}
	journeyID, err := utilities.NewID()
	if err != nil {
		return errors.New("allocate backfill journey identity")
	}
	ctx = observability.ContextWithJourneyID(ctx, journeyID)
	endpoint := strings.TrimSpace(os.Getenv(config.APIOTLPEndpoint))
	telemetry, err := observability.Start(ctx, observability.Config{
		Environment: os.Getenv(config.APIEnvironment), Service: "chalk-recording-backfill", Version: os.Getenv(config.APIVersion),
		OTLPEndpoint: endpoint, OTLPInsecure: strings.EqualFold(os.Getenv(config.APIOTLPInsecure), "true"),
	})
	if err != nil {
		return fmt.Errorf("start backfill telemetry: %w", err)
	}
	shutdownTracing := telemetry.Shutdown
	if endpoint == "" {
		// Keep durable trace links even for local runs without an exporter.
		provider := sdktrace.NewTracerProvider()
		otel.SetTracerProvider(provider)
		shutdownTracing = provider.Shutdown
	}
	defer func() {
		shutdownCtx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		runErr = errors.Join(runErr, shutdownTracing(shutdownCtx))
	}()
	tracer := otel.Tracer("github.com/q9labs/chalk/apps/api/cmd/recording-backfill")
	ctx, batchSpan := tracer.Start(ctx, "recording.render.backfill", trace.WithAttributes(attribute.String("chalk.journey.id", journeyID.String())))
	defer batchSpan.End()
	poolConfig, err := pgxpool.ParseConfig(url)
	if err != nil {
		return errors.New("invalid database configuration")
	}
	if !*apply {
		poolConfig.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return errors.New("open backfill database")
	}
	defer pool.Close()
	store, err := r2.NewStore(config.R2Config{
		AccessKeyID: os.Getenv(config.R2AccessKeyID), SecretAccessKey: os.Getenv(config.R2SecretAccessKey),
		AccountID: os.Getenv(config.R2AccountID), Bucket: os.Getenv(config.R2Bucket),
		Endpoint: os.Getenv(config.R2Endpoint), RequestTimeout: 10 * time.Second,
	})
	if err != nil {
		return errors.New("invalid object storage configuration")
	}
	candidates, err := sqlc.New(pool).ListRecordingRenderBackfillCandidates(ctx, sqlc.ListRecordingRenderBackfillCandidatesParams{
		AfterRecordingID: cursor, BatchSize: int32(*batchSize),
	})
	if err != nil {
		return databaseFailure("inventory backfill captures", err)
	}
	result := report{DryRun: !*apply}
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return errors.Join(json.NewEncoder(out).Encode(result), err)
		}
		result.Inspected++
		recordingID := utilities.IDFromBytes(candidate.RecordingID.Bytes)
		result.NextAfter = recordingID.String()
		if candidate.AlreadyQueued.Bool {
			result.AlreadyQueued++
			continue
		}
		if !candidate.SourceExpiresAt.Valid || !candidate.SourceExpiresAt.Time.After(time.Now()) {
			result.Expired++
			continue
		}
		if !candidate.HasBundles || !candidate.HasKey || !candidate.HasPresentation || len(candidate.ObjectKeys) == 0 {
			result.MissingSource++
			continue
		}
		available, inspectErr := inspectSources(ctx, store, candidate.ObjectKeys)
		if inspectErr != nil {
			result.Unverifiable++
			continue
		}
		if !available {
			result.MissingSource++
			continue
		}
		result.Recoverable++
		if !*apply {
			continue
		}
		jobID, err := utilities.NewID()
		if err != nil {
			return errors.New("allocate backfill job identity")
		}
		queueCtx, queueSpan := tracer.Start(ctx, "recording.render.backfill.queue", trace.WithAttributes(
			attribute.String("recording.id", recordingID.String()), attribute.String("recording.job.id", jobID.String()),
		))
		job, err := repository.QueueBackfillRender(queueCtx, recordingpipeline.ExportInput{
			TenantID: utilities.IDFromBytes(candidate.TenantID.Bytes), RecordingID: recordingID,
		}, jobID)
		if err != nil {
			queueSpan.RecordError(databaseFailure("queue backfill render", err))
		}
		queueSpan.End()
		if errors.Is(err, recordingpipeline.ErrExportUnavailable) {
			result.Recoverable--
			result.NoLongerEligible++
			continue
		}
		if err != nil {
			return errors.Join(json.NewEncoder(out).Encode(result), databaseFailure("queue backfill render; rerunning is idempotent", err))
		}
		if job.ID == jobID {
			result.Queued++
		} else {
			result.AlreadyQueued++
		}
	}
	return json.NewEncoder(out).Encode(result)
}

func inspectSources(ctx context.Context, store r2.Store, keys []string) (bool, error) {
	for _, key := range keys {
		facts, err := store.InspectObject(ctx, key)
		if errors.Is(err, objectstorage.ErrObjectNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if facts.Size <= 0 {
			return false, nil
		}
	}
	return true, nil
}

// Driver messages can include credentials or customer SQL. Keep only a bounded category.
func databaseFailure(stage string, err error) error {
	category := "database_error"
	var state interface{ SQLState() string }
	var network net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		category = "timeout"
	case errors.Is(err, context.Canceled):
		category = "canceled"
	case errors.As(err, &state):
		code := state.SQLState()
		valid := len(code) == 5
		for _, c := range code {
			valid = valid && ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'))
		}
		if valid {
			category = "sqlstate_" + code
		}
	case errors.As(err, &network):
		category = "connection_failed"
	}
	return fmt.Errorf("%s (%s)", stage, category)
}

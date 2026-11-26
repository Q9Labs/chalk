// recording-transcription-rearm inventories expired transcription preparations. It is read-only unless --apply is explicit.
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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
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

type recordingList []string

func (list *recordingList) String() string { return strings.Join(*list, ",") }
func (list *recordingList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("empty recording id")
	}
	*list = append(*list, value)
	return nil
}

type recordingOutcome struct {
	RecordingID     string `json:"recording_id"`
	JobID           string `json:"job_id,omitempty"`
	Outcome         string `json:"outcome"`
	SourceExpiresAt string `json:"source_expires_at,omitempty"`
}

type report struct {
	DryRun           bool               `json:"dry_run"`
	Inspected        int                `json:"inspected"`
	Eligible         int                `json:"eligible"`
	Rearmed          int                `json:"rearmed"`
	AlreadyRearmed   int                `json:"already_rearmed"`
	Completed        int                `json:"completed"`
	NotEligible      int                `json:"not_eligible"`
	MissingSource    int                `json:"missing_source"`
	Unverifiable     int                `json:"unverifiable"`
	NoLongerEligible int                `json:"no_longer_eligible"`
	NextAfter        string             `json:"next_after_recording,omitempty"`
	Recordings       []recordingOutcome `json:"recordings"`
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "recording-transcription-rearm:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out, stderr io.Writer) error {
	flags := flag.NewFlagSet("recording-transcription-rearm", flag.ContinueOnError)
	var explicit recordingList
	flags.Var(&explicit, "recording", "recording UUID to inspect; repeatable")
	batchSize := flags.Int("batch-size", 0, "inspect at most 1-100 expired transcription jobs")
	apply := flags.Bool("apply", false, "re-arm verified recordings; default is a read-only dry run")
	after := flags.String("after-recording", "", "continue batch inventory after the previous report's cursor")
	operator := flags.String("operator", "", "operator identity recorded on each renewal")
	reason := flags.String("reason", "", "operator reason recorded on each renewal")
	limit := flags.Duration("timeout", 15*time.Minute, "whole-command deadline, at most 20 minutes")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || (len(explicit) == 0 && *batchSize == 0) || *batchSize < 0 || *batchSize > 100 || *limit <= 0 || *limit > 20*time.Minute {
		return errors.New("use --recording at least once and/or --batch-size (1-100), with --timeout (0-20m); no positional arguments")
	}
	if *after != "" && *batchSize == 0 {
		return errors.New("--after-recording requires --batch-size")
	}
	if *apply && (strings.TrimSpace(*operator) == "" || len(*operator) > 256 || strings.TrimSpace(*reason) == "" || len(*reason) > 1024) {
		return errors.New("--apply requires --operator (1-256 bytes) and --reason (1-1024 bytes)")
	}
	recordingIDs := make([]utilities.ID, 0, len(explicit))
	seen := map[utilities.ID]bool{}
	for _, value := range explicit {
		id, err := utilities.ParseID(value)
		if err != nil {
			return errors.New("invalid --recording id")
		}
		if !seen[id] {
			seen[id] = true
			recordingIDs = append(recordingIDs, id)
		}
	}
	var cursor *utilities.ID
	if *after != "" {
		id, err := utilities.ParseID(*after)
		if err != nil {
			return errors.New("invalid --after-recording cursor")
		}
		cursor = &id
	}
	ctx, cancel := context.WithTimeout(ctx, *limit)
	defer cancel()
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		return errors.New("CHALK_DATABASE_URL required")
	}
	journeyID, err := utilities.NewID()
	if err != nil {
		return errors.New("allocate re-arm journey identity")
	}
	ctx = observability.ContextWithJourneyID(ctx, journeyID)
	endpoint := strings.TrimSpace(os.Getenv(config.APIOTLPEndpoint))
	telemetry, err := observability.Start(ctx, observability.Config{
		Environment: os.Getenv(config.APIEnvironment), Service: "chalk-recording-transcription-rearm", Version: os.Getenv(config.APIVersion),
		OTLPEndpoint: endpoint, OTLPInsecure: strings.EqualFold(os.Getenv(config.APIOTLPInsecure), "true"),
	})
	if err != nil {
		return fmt.Errorf("start re-arm telemetry: %w", err)
	}
	shutdownTracing := telemetry.Shutdown
	if endpoint == "" {
		provider := sdktrace.NewTracerProvider()
		otel.SetTracerProvider(provider)
		shutdownTracing = provider.Shutdown
	}
	defer func() {
		shutdownCtx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		if err := shutdownTracing(shutdownCtx); err != nil {
			fmt.Fprintln(stderr, "recording-transcription-rearm: warning: telemetry shutdown:", err)
		}
	}()
	tracer := otel.Tracer("github.com/q9labs/chalk/apps/api/cmd/recording-transcription-rearm")
	ctx, batchSpan := tracer.Start(ctx, "recording.transcription.rearm", trace.WithAttributes(attribute.String("chalk.journey.id", journeyID.String())))
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
		return errors.New("open re-arm database")
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
	repository := postgres.NewRecordingPipelineRepositoryWithPool(pool)
	result := report{DryRun: !*apply, Recordings: []recordingOutcome{}}
	candidates := make([]recordingpipeline.TranscriptionRearmCandidate, 0, len(recordingIDs)+*batchSize)
	missing := []utilities.ID{}
	for _, recordingID := range recordingIDs {
		candidate, err := repository.GetTranscriptionRearmCandidate(ctx, recordingID)
		if errors.Is(err, recordingpipeline.ErrJobNotFound) {
			missing = append(missing, recordingID)
			continue
		}
		if err != nil {
			return databaseFailure("inspect transcription re-arm recording", err)
		}
		candidates = append(candidates, candidate)
	}
	for _, recordingID := range missing {
		result.Inspected++
		result.NotEligible++
		result.Recordings = append(result.Recordings, recordingOutcome{RecordingID: recordingID.String(), Outcome: "not_found"})
	}
	batchIDs := map[utilities.ID]bool{}
	if *batchSize > 0 {
		listed, err := repository.ListTranscriptionRearmCandidates(ctx, cursor, *batchSize)
		if err != nil {
			return databaseFailure("inventory transcription re-arm candidates", err)
		}
		for _, candidate := range listed {
			if seen[candidate.RecordingID] {
				continue
			}
			batchIDs[candidate.RecordingID] = true
			candidates = append(candidates, candidate)
		}
	}
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return errors.Join(json.NewEncoder(out).Encode(result), err)
		}
		result.Inspected++
		if batchIDs[candidate.RecordingID] {
			result.NextAfter = candidate.RecordingID.String()
		}
		outcome := recordingOutcome{RecordingID: candidate.RecordingID.String(), JobID: candidate.JobID.String()}
		refusal := recordingpipeline.TranscriptionRearmRefusal(candidate, time.Now().UTC())
		if refusal != "" {
			outcome.Outcome = refusal
			countRefusal(&result, refusal)
			result.Recordings = append(result.Recordings, outcome)
			continue
		}
		available, inspectErr := inspectSources(ctx, store, candidate.ObjectKeys)
		if inspectErr != nil {
			result.Unverifiable++
			outcome.Outcome = "unverifiable"
			result.Recordings = append(result.Recordings, outcome)
			continue
		}
		if !available {
			result.MissingSource++
			outcome.Outcome = "missing_source"
			result.Recordings = append(result.Recordings, outcome)
			continue
		}
		if !*apply {
			result.Eligible++
			outcome.Outcome = "eligible"
			result.Recordings = append(result.Recordings, outcome)
			continue
		}
		rearmCtx, rearmSpan := tracer.Start(ctx, "recording.transcription.rearm.apply", trace.WithAttributes(
			attribute.String("recording.id", candidate.RecordingID.String()), attribute.String("recording.job.id", candidate.JobID.String()),
		))
		rearmed, err := repository.RearmTranscription(rearmCtx, recordingpipeline.TranscriptionRearmInput{
			RecordingID: candidate.RecordingID, Operator: *operator, Reason: *reason,
		})
		rearmSpan.End()
		if errors.Is(err, recordingpipeline.ErrTranscriptionRearmNotNeeded) {
			result.AlreadyRearmed++
			outcome.Outcome = "already_rearmed"
			result.Recordings = append(result.Recordings, outcome)
			continue
		}
		if errors.Is(err, recordingpipeline.ErrTranscriptionRearmUnavailable) {
			result.NoLongerEligible++
			outcome.Outcome = "no_longer_eligible"
			result.Recordings = append(result.Recordings, outcome)
			continue
		}
		if err != nil {
			return errors.Join(json.NewEncoder(out).Encode(result), databaseFailure("apply transcription re-arm; rerunning is idempotent", err))
		}
		result.Rearmed++
		outcome.Outcome = "rearmed"
		outcome.SourceExpiresAt = rearmed.SourceExpiresAt.Format(time.RFC3339)
		result.Recordings = append(result.Recordings, outcome)
	}
	return json.NewEncoder(out).Encode(result)
}

func countRefusal(result *report, refusal string) {
	switch refusal {
	case "already_rearmed":
		result.AlreadyRearmed++
	case "completed":
		result.Completed++
	case "missing_source":
		result.MissingSource++
	default:
		result.NotEligible++
	}
}

func inspectSources(ctx context.Context, store r2.Store, keys []string) (bool, error) {
	if len(keys) == 0 {
		return false, nil
	}
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

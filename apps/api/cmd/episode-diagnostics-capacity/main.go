package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"time"
)

func main() {
	config, err := parseConfig(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "episode-diagnostics-capacity: %v\n", err)
		os.Exit(2)
	}

	report, runErr := run(context.Background(), config)
	if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
		fmt.Fprintf(os.Stderr, "episode-diagnostics-capacity: encode report: %v\n", err)
		os.Exit(1)
	}
	if runErr != nil {
		fmt.Fprintf(os.Stderr, "episode-diagnostics-capacity: %v\n", runErr)
		os.Exit(1)
	}
}

func parseConfig(args []string, env func(string) string) (config, error) {
	defaults := configFromEnv(env)
	flags := flag.NewFlagSet("episode-diagnostics-capacity", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.Int64Var(&defaults.Events, "events", defaults.Events, "number of diagnostic events to append")
	flags.IntVar(&defaults.Participants, "participants", defaults.Participants, "number of participant scopes to exercise")
	flags.IntVar(&defaults.Viewers, "viewers", defaults.Viewers, "concurrent diagnostics viewers")
	flags.IntVar(&defaults.BatchSize, "batch-size", defaults.BatchSize, "events per append request (bounded to the API limit)")
	flags.IntVar(&defaults.AppendWorkers, "append-workers", defaults.AppendWorkers, "bounded append worker count")
	flags.IntVar(&defaults.PageSize, "page-size", defaults.PageSize, "events per page request")
	flags.IntVar(&defaults.Reconnects, "reconnects", defaults.Reconnects, "reconnects per viewer after the first stream")
	flags.DurationVar(&defaults.StreamDuration, "stream-duration", defaults.StreamDuration, "maximum duration of each SSE connection")
	flags.DurationVar(&defaults.RetentionWait, "retention-wait", defaults.RetentionWait, "optional wait before the retention probe snapshot")
	flags.StringVar(&defaults.BaseURL, "base-url", defaults.BaseURL, "API base URL")
	flags.StringVar(&defaults.Reference, "reference", defaults.Reference, "diagnostic reference, or empty to learn it from append")
	flags.StringVar(&defaults.ProducerToken, "producer-token", defaults.ProducerToken, "static diagnostics producer token")
	flags.StringVar(&defaults.OperatorToken, "operator-token", defaults.OperatorToken, "diagnostics operator token for reads")
	flags.StringVar(&defaults.TenantID, "tenant-id", defaults.TenantID, "scope tenant UUID")
	flags.StringVar(&defaults.SpaceID, "space-id", defaults.SpaceID, "scope space UUID")
	flags.StringVar(&defaults.EpisodeID, "episode-id", defaults.EpisodeID, "scope episode UUID")
	flags.StringVar(&defaults.ProducerInstance, "producer-instance", defaults.ProducerInstance, "producer instance identifier")
	flags.StringVar(&defaults.RetentionProbeURL, "retention-probe-url", defaults.RetentionProbeURL, "optional operator-only retention probe URL")
	flags.BoolVar(&defaults.DryRun, "dry-run", defaults.DryRun, "validate and report the plan without network calls")
	flags.BoolVar(&defaults.AcknowledgeExecution, "acknowledge-execution", defaults.AcknowledgeExecution, "acknowledge that a non-dry-run may mutate diagnostic state")
	flags.BoolVar(&defaults.AllowRemote, "allow-remote", defaults.AllowRemote, "allow mutations against a non-loopback API URL")
	flags.BoolVar(&defaults.AllowProduction, "allow-production", defaults.AllowProduction, "explicitly acknowledge a remote production-sensitive target")
	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
	if flags.NArg() != 0 {
		return config{}, fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	return defaults, validateConfig(defaults)
}

func configFromEnv(env func(string) string) config {
	if env == nil {
		env = os.Getenv
	}
	return config{
		BaseURL:              envString(env, "CHALK_API_BASE_URL", "http://localhost:8080"),
		Events:               envInt64(env, "CHALK_EPISODE_DIAGNOSTICS_EVENTS", 1_000_000),
		Participants:         envInt(env, "CHALK_EPISODE_DIAGNOSTICS_PARTICIPANTS", 100),
		Viewers:              envInt(env, "CHALK_EPISODE_DIAGNOSTICS_VIEWERS", 10),
		BatchSize:            envInt(env, "CHALK_EPISODE_DIAGNOSTICS_BATCH_SIZE", 200),
		AppendWorkers:        envInt(env, "CHALK_EPISODE_DIAGNOSTICS_APPEND_WORKERS", 8),
		PageSize:             envInt(env, "CHALK_EPISODE_DIAGNOSTICS_PAGE_SIZE", 1000),
		Reconnects:           envInt(env, "CHALK_EPISODE_DIAGNOSTICS_RECONNECTS", 1),
		StreamDuration:       envDuration(env, "CHALK_EPISODE_DIAGNOSTICS_STREAM_DURATION", defaultStreamDuration),
		RetentionWait:        envDuration(env, "CHALK_EPISODE_DIAGNOSTICS_RETENTION_WAIT", 0),
		Reference:            envString(env, "CHALK_EPISODE_DIAGNOSTICS_REFERENCE", ""),
		ProducerToken:        envString(env, "CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN", ""),
		OperatorToken:        envString(env, "CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN", ""),
		TenantID:             envString(env, "CHALK_EPISODE_DIAGNOSTICS_TENANT_ID", defaultTenantID),
		SpaceID:              envString(env, "CHALK_EPISODE_DIAGNOSTICS_SPACE_ID", defaultSpaceID),
		EpisodeID:            envString(env, "CHALK_EPISODE_DIAGNOSTICS_EPISODE_ID", defaultEpisodeID),
		ProducerInstance:     envString(env, "CHALK_EPISODE_DIAGNOSTICS_PRODUCER_INSTANCE", "capacity-harness"),
		RetentionProbeURL:    envString(env, "CHALK_EPISODE_DIAGNOSTICS_RETENTION_PROBE_URL", ""),
		DryRun:               envBool(env, "CHALK_EPISODE_DIAGNOSTICS_DRY_RUN", true),
		AcknowledgeExecution: envBool(env, "CHALK_EPISODE_DIAGNOSTICS_ACKNOWLEDGE_EXECUTION", false),
		AllowRemote:          envBool(env, "CHALK_EPISODE_DIAGNOSTICS_ALLOW_REMOTE", false),
		AllowProduction:      envBool(env, "CHALK_EPISODE_DIAGNOSTICS_ALLOW_PRODUCTION", false),
	}
}

func validateConfig(value config) error {
	if value.Events < 0 {
		return errors.New("events must be non-negative")
	}
	if value.Participants < 1 || value.Participants > 100_000 {
		return errors.New("participants must be between 1 and 100000")
	}
	if value.Viewers < 0 || value.Viewers > 1_000 {
		return errors.New("viewers must be between 0 and 1000")
	}
	if value.BatchSize < 1 || value.BatchSize > maxAppendBatchSize {
		return fmt.Errorf("batch-size must be between 1 and %d", maxAppendBatchSize)
	}
	if value.AppendWorkers < 1 || value.AppendWorkers > 256 {
		return errors.New("append-workers must be between 1 and 256")
	}
	if value.PageSize < 1 || value.PageSize > maxPageSize {
		return fmt.Errorf("page-size must be between 1 and %d", maxPageSize)
	}
	if value.Reconnects < 0 || value.Reconnects > 100 {
		return errors.New("reconnects must be between 0 and 100")
	}
	if value.StreamDuration <= 0 || value.StreamDuration > maxStreamDuration {
		return fmt.Errorf("stream-duration must be between 1ns and %s", maxStreamDuration)
	}
	if value.RetentionWait < 0 || value.RetentionWait > maxRetentionWait {
		return fmt.Errorf("retention-wait must be between 0 and %s", maxRetentionWait)
	}
	parsedURL, err := url.Parse(value.BaseURL)
	if err != nil || parsedURL.Scheme == "" || parsedURL.Host == "" {
		return errors.New("base-url must be an absolute URL")
	}
	if !value.DryRun && !value.AcknowledgeExecution {
		return errors.New("acknowledge-execution is required when dry-run is disabled")
	}
	mutating := value.Events > 0 && !value.DryRun
	if mutating && !isLoopbackBaseURL(value.BaseURL) && !value.AllowRemote {
		return errors.New("allow-remote is required for non-loopback mutations")
	}
	if mutating && !isLoopbackBaseURL(value.BaseURL) && !value.AllowProduction {
		return errors.New("allow-production is required for remote production-sensitive mutations")
	}
	if mutating && value.ProducerToken == "" {
		return errors.New("producer-token is required when events are enabled")
	}
	return nil
}

func envString(env func(string) string, key, fallback string) string {
	if value := env(key); value != "" {
		return value
	}
	return fallback
}

func envInt(env func(string) string, key string, fallback int) int {
	value := envString(env, key, "")
	if value == "" {
		return fallback
	}
	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil {
		return fallback
	}
	return parsed
}

func envInt64(env func(string) string, key string, fallback int64) int64 {
	value := envString(env, key, "")
	if value == "" {
		return fallback
	}
	var parsed int64
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil {
		return fallback
	}
	return parsed
}

func envDuration(env func(string) string, key string, fallback time.Duration) time.Duration {
	value := envString(env, key, "")
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(env func(string) string, key string, fallback bool) bool {
	value := envString(env, key, "")
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes"
}

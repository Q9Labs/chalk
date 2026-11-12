package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

type observed struct {
	diagnostics observability.Diagnostics
	logger      *slog.Logger
	launch      *observability.LaunchTelemetry
}

// startObservability starts telemetry and installs the process logger. The
// returned function flushes telemetry and runs last on shutdown.
func startObservability(cfg config.Config) (observed, func(), error) {
	telemetry, err := observability.Start(context.Background(), observability.Config{
		Environment:  cfg.Observability.Environment,
		OTLPEndpoint: cfg.Observability.OTLPEndpoint,
		OTLPInsecure: cfg.Observability.OTLPInsecure,
		Service:      cfg.Observability.Service,
		Version:      cfg.Observability.Version,
	})
	if err != nil {
		return observed{}, nil, fmt.Errorf("start telemetry: %w", err)
	}
	stop := func() {
		shutdownCtx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		if err := telemetry.Shutdown(shutdownCtx); err != nil {
			fmt.Fprintf(os.Stderr, "api: shutdown telemetry: %v\n", err)
		}
	}

	diagnostics := observability.New(observability.Config{
		Environment:          cfg.Observability.Environment,
		LogFormat:            observability.LogFormat(cfg.Observability.LogFormat),
		LogLevel:             cfg.Observability.LogLevel,
		OTLPEndpoint:         cfg.Observability.OTLPEndpoint,
		OTLPInsecure:         cfg.Observability.OTLPInsecure,
		OperationLogs:        cfg.Observability.OperationLogs,
		Profiler:             cfg.Observability.Profiler,
		RequestLogs:          observability.RequestLogMode(cfg.Observability.RequestLogs),
		RequestSampleRate:    cfg.Observability.RequestSampleRate,
		Service:              cfg.Observability.Service,
		SlowRequestThreshold: cfg.Observability.SlowRequestThreshold,
		Version:              cfg.Observability.Version,
	}, os.Stdout)
	logger := diagnostics.Logger()
	slog.SetDefault(logger)
	obs := observed{diagnostics: diagnostics, logger: logger, launch: observability.NewLaunchTelemetry(logger)}
	obs.logStarting(cfg)
	return obs, stop, nil
}

func (o observed) logStarting(cfg config.Config) {
	o.logger.Info("api starting",
		"event", "api.starting",
		"previous_boot_end", previousBootEnd(os.Getenv("CHALK_PREVIOUS_BOOT_END")),
		"host_boot_id", os.Getenv("CHALK_HOST_BOOT_ID"),
		"address", cfg.API.Address,
		"log_format", cfg.Observability.LogFormat,
		"log_level", cfg.Observability.LogLevel,
		"otlp_endpoint_configured", cfg.Observability.OTLPEndpoint != "",
		"operation_logs", cfg.Observability.OperationLogs,
		"profiler", cfg.Observability.Profiler,
		"request_logs", cfg.Observability.RequestLogs,
		"recording_enabled", cfg.Capabilities.Recording,
		"transcription_enabled", cfg.Capabilities.Transcription,
	)
}

// previousBootEnd is how the host says its previous boot ended. Anything else, including a
// host without the restore service, reads as unknown so the field stays a small enum.
func previousBootEnd(value string) string {
	switch value {
	case "clean", "killed":
		return value
	default:
		return "unknown"
	}
}

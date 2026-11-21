package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func startTelemetry(cfg config.ObservabilityConfig) (observability.AxiomEvidence, func(), error) {
	sink, err := observability.NewAxiomEvidence(cfg.OTLPEndpoint, os.Getenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS"))
	if err != nil {
		return observability.AxiomEvidence{}, nil, err
	}
	telemetry, err := observability.Start(context.Background(), observability.Config{
		Environment:  cfg.Environment,
		OTLPEndpoint: cfg.OTLPEndpoint,
		OTLPInsecure: cfg.OTLPInsecure,
		Service:      cfg.Service,
		Version:      cfg.Version,
	})
	if err != nil {
		return observability.AxiomEvidence{}, nil, fmt.Errorf("start telemetry: %w", err)
	}
	return sink, func() {
		ctx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		if err := telemetry.Shutdown(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "api: shutdown telemetry: %v\n", err)
		}
	}, nil
}

func startEvidenceRelay(ctx context.Context, ledger postgres.TelemetryLedger, sink observability.AxiomEvidence, logger *slog.Logger) func() {
	// Without an Axiom ingest grant the evidence still has to leave the queue, so it goes to the
	// service log, where the same rows reach whatever the installation reads logs from.
	export := observability.EvidenceExport(sink.Export)
	if !sink.Enabled() {
		export = observability.LogEvidence(logger)
	}
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		observability.RunEvidenceRelay(ctx, ledger.RelayEvidence, export, logger)
	}()
	return func() {
		cancel()
		<-done
	}
}

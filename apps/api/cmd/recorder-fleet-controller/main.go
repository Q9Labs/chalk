package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/q9labs/chalk/apps/api/internal/adapters/recordercontrollease"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "recorder-fleet-controller:", err)
		os.Exit(1)
	}
}

func run() error {
	config, err := loadCommandConfig(os.Args[1:], os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	telemetry, err := observability.StartWorker(ctx, "chalk-recorder-fleet-controller", os.Getenv, os.Stderr)
	if err != nil {
		return err
	}
	defer telemetry.Close("recorder-fleet-controller", os.Stderr)
	logger := slog.Default()
	logStartupWarnings(config, logger)
	lease, err := recordercontrollease.Acquire(config.JournalPath)
	if err != nil {
		return err
	}
	defer lease.Close()
	reconciler, err := buildReconciler(config, logger)
	if err != nil {
		return err
	}
	return runLoop(ctx, config.ReconcileInterval, reconciler, logger)
}

func logStartupWarnings(config commandConfig, logger *slog.Logger) {
	if !config.BootstrapNameVerified {
		logger.Warn("baked bootstrap name claims absent; continuing without fleet bootstrap name verification; publisher can enable it with CHALK_RECORDER_FLEET_BOOTSTRAP_SERVER_NAME and CHALK_RECORDER_FLEET_BOOTSTRAP_NAME_IMAGE_DIGEST")
	}
}

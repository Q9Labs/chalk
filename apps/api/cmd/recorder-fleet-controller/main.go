package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/q9labs/chalk/apps/api/internal/adapters/recordercontrollease"
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
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	logStartupWarnings(config, logger)
	lease, err := recordercontrollease.Acquire(config.JournalPath)
	if err != nil {
		return err
	}
	defer lease.Close()
	reconciler, err := buildReconciler(config)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runLoop(ctx, config.ReconcileInterval, reconciler, logger)
}

func logStartupWarnings(config commandConfig, logger *slog.Logger) {
	if !config.BootstrapNameVerified {
		logger.Warn("baked bootstrap name claims absent; continuing without fleet bootstrap name verification; publisher can enable it with CHALK_RECORDER_FLEET_BOOTSTRAP_SERVER_NAME and CHALK_RECORDER_FLEET_BOOTSTRAP_NAME_IMAGE_DIGEST")
	}
}

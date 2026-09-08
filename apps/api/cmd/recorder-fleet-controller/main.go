package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
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
	reconciler, err := buildReconciler(config)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	return runLoop(ctx, config.ReconcileInterval, reconciler, logger)
}

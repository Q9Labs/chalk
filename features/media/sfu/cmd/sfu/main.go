// Command sfu runs the Chalk SFU control service and media node.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/control"
	"github.com/q9labs/chalk/features/media/sfu/internal/telemetry"
)

func main() {
	if err := run(); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("sfu stopped", "error", err)
		os.Exit(1)
	}
}

// The container stops the node with SIGKILL 20 s after SIGTERM (--stop-timeout in
// infrastructure/sfu/chalk-sfu.container.in). The stop gets a budget that leaves the last export
// room to finish before that, so the final session-closed lines reach the store.
const (
	stopTimeout    = 20 * time.Second
	exportShutdown = 3 * time.Second
	stopBudget     = stopTimeout - exportShutdown - time.Second
)

func run() error {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		return err
	}
	log, diag, closeLogs, err := telemetry.NewLogger(context.Background(), cfg.Telemetry, cfg.Incarnation, slog.NewJSONHandler(os.Stderr, nil))
	if err != nil {
		return err
	}
	// Closing last sends the final records, including the shutdown ones. The exporters flush
	// together, so the two share one export budget.
	flushes := []func(context.Context) error{closeLogs}
	defer func() { flush(log, flushes) }()
	if cfg.Telemetry.OTLPEndpoint != "" && !diag.LogsExport() {
		log.Warn("log export is off: OTEL_EXPORTER_OTLP_LOGS_HEADERS is empty, so the diagnosis trail stays in the journal and never reaches the store; the chalk.sfu.telemetry.logs_export gauge reads 0")
	}
	server, err := control.Start(cfg, log)
	if err != nil {
		return err
	}
	log.Info("sfu listening", "control", server.Addr().String(), "udpPort", server.UDPPort())
	exporter, err := telemetry.Start(context.Background(), cfg.Telemetry, server.Incarnation(), server.Telemetry, diag, log)
	if err != nil {
		return errors.Join(err, stopServer(server))
	}
	// Stopping last sends a final export that shows the node's sessions gone.
	flushes = append(flushes, exporter.Shutdown)

	signals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	drain := make(chan os.Signal, 1)
	notifyDrain(drain)
	defer signal.Stop(drain)
	ticker := time.NewTicker(time.Second)
	ticker.Stop() // runs only while a drain waits for the last session
	defer ticker.Stop()
	waiting := false
	for {
		select {
		case <-signals.Done():
			log.Info("sfu stopping")
			return stopServer(server)
		case <-drain:
			// SIGUSR1 drains without stopping, so an operator can wait for live
			// calls to end before a restart. "sfu drained" marks the last one.
			server.Drain()
			waiting = true
			ticker.Reset(time.Second)
		case <-ticker.C:
			state := server.DrainState()
			switch {
			case !waiting:
			case !state.Draining: // a control request called the restart off
				waiting = false
				ticker.Stop()
			case state.Allocations == 0 && state.CleanupDebt == 0:
				log.Info("sfu drained")
				waiting = false
				ticker.Stop()
			}
		}
	}
}

// stopServer drains the server inside the stop budget.
func stopServer(server *control.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), stopBudget)
	defer cancel()
	return server.Stop(ctx)
}

// flush runs the final exports together under one deadline, so two slow stores cost one wait.
func flush(log *slog.Logger, exports []func(context.Context) error) {
	ctx, cancel := context.WithTimeout(context.Background(), exportShutdown)
	defer cancel()
	var wg sync.WaitGroup
	for _, export := range exports {
		wg.Go(func() {
			if err := export(ctx); err != nil {
				log.Warn("telemetry shutdown failed", "error", err)
			}
		})
	}
	wg.Wait()
}

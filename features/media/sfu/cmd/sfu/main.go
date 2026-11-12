// Command sfu runs the Chalk SFU control service and media node.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
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

// exportShutdown bounds the final export, inside the container's stop timeout.
const exportShutdown = 3 * time.Second

func run() error {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		return err
	}
	log, closeLogs, err := telemetry.NewLogger(context.Background(), cfg.Telemetry, slog.NewJSONHandler(os.Stderr, nil))
	if err != nil {
		return err
	}
	// Closing last sends the final records, including the shutdown ones.
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), exportShutdown)
		defer cancel()
		if err := closeLogs(ctx); err != nil {
			slog.Warn("log shutdown failed", "error", err)
		}
	}()
	server, err := control.Start(cfg, log)
	if err != nil {
		return err
	}
	log.Info("sfu listening", "control", server.Addr().String(), "udpPort", server.UDPPort())
	exporter, err := telemetry.Start(context.Background(), cfg.Telemetry, server.Incarnation(), server.Telemetry, log)
	if err != nil {
		return errors.Join(err, server.Stop(context.Background()))
	}
	// Stopping last sends a final export that shows the node's sessions gone.
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), exportShutdown)
		defer cancel()
		if err := exporter.Shutdown(ctx); err != nil {
			log.Warn("telemetry shutdown failed", "error", err)
		}
	}()

	signals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	drain := make(chan os.Signal, 1)
	signal.Notify(drain, syscall.SIGUSR1)
	defer signal.Stop(drain)
	watch := &drainWatch{server: server, log: log, ticker: time.NewTicker(time.Second)}
	watch.ticker.Stop() // runs only while a drain waits for the last session
	defer watch.ticker.Stop()
	for {
		select {
		case <-signals.Done():
			log.Info("sfu stopping")
			return server.Stop(context.Background())
		case <-drain:
			watch.begin()
		case <-watch.ticker.C:
			watch.check()
		}
	}
}

// drainWatch follows a drain that SIGUSR1 started until the last session is gone.
type drainWatch struct {
	server  *control.Server
	log     *slog.Logger
	ticker  *time.Ticker
	waiting bool
}

// begin drains without stopping, so an operator can wait for live calls to end before a
// restart. "sfu drained" marks the last one.
func (w *drainWatch) begin() {
	w.server.Drain()
	w.waiting = true
	w.ticker.Reset(time.Second)
}

func (w *drainWatch) check() {
	state := w.server.DrainState()
	switch {
	case !w.waiting:
	case !state.Draining: // a control request called the restart off
		w.waiting = false
		w.ticker.Stop()
	case state.Allocations == 0 && state.CleanupDebt == 0:
		w.log.Info("sfu drained")
		w.waiting = false
		w.ticker.Stop()
	}
}

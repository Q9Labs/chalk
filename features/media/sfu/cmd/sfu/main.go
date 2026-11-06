// Command sfu runs the Chalk SFU control service and media node.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/control"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("sfu stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		return err
	}
	server, err := control.Start(cfg, log)
	if err != nil {
		return err
	}
	log.Info("sfu listening", "control", server.Addr().String(), "udpPort", server.UDPPort())

	signals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	drain := make(chan os.Signal, 1)
	signal.Notify(drain, syscall.SIGUSR1)
	defer signal.Stop(drain)
	ticker := time.NewTicker(time.Second)
	ticker.Stop() // runs only while a drain waits for the last session
	defer ticker.Stop()
	waiting := false
	for {
		select {
		case <-signals.Done():
			log.Info("sfu stopping")
			return server.Stop(context.Background())
		case <-drain:
			// SIGUSR1 drains without stopping, so an operator can wait for live
			// calls to end before a restart. "sfu drained" marks the last one.
			log.Info("sfu draining", "sessions", server.Drain())
			waiting = true
			ticker.Reset(time.Second)
		case <-ticker.C:
			if waiting && server.Drain() == 0 {
				log.Info("sfu drained")
				waiting = false
				ticker.Stop()
			}
		}
	}
}

// Command sfu runs the Chalk SFU control service and media node.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

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
	<-signals.Done()
	log.Info("sfu draining")
	return server.Stop(context.Background())
}

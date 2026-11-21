package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/adapters/discordreports"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	postgressqlc "github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "api: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	reportAdapter, err := discordreports.NewAdapter(cfg.ProblemReportsDiscordWebhookURL)
	if err != nil {
		return fmt.Errorf("configure CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL: %w", err)
	}
	evidenceSink, shutdownTelemetry, err := startTelemetry(cfg.Observability)
	if err != nil {
		return err
	}
	defer shutdownTelemetry()

	diagnostics := newDiagnostics(cfg)
	logger := diagnostics.Logger()
	slog.SetDefault(logger)
	launchTelemetry := observability.NewLaunchTelemetry(logger)
	logStartup(logger, cfg)

	pool, err := postgres.Open(context.Background(), cfg.Database)
	if err != nil {
		return fmt.Errorf("open postgres: %w", err)
	}
	defer pool.Close()
	logger.Info("postgres connected", "event", "postgres.connected")

	w := apiWiring{
		cfg: cfg, pool: pool, diagnostics: diagnostics, logger: logger,
		queries:         diagnostics.Queries(postgressqlc.New(pool)),
		launchTelemetry: launchTelemetry, evidenceSink: evidenceSink,
	}
	if err := w.openRedis(); err != nil {
		return err
	}
	if w.redisClient != nil {
		defer w.redisClient.Close()
	}
	if err := w.wireServices(); err != nil {
		return err
	}
	server, err := w.wireRouters(reportAdapter)
	if err != nil {
		return err
	}
	return w.serve(server)
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

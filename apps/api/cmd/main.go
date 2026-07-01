package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/postgres"
	postgresdb "github.com/q9labs/chalk/apps/api/internal/postgres/db"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
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

	diagnostics := observability.New(observability.Config{
		Environment:          cfg.Observability.Environment,
		LogFormat:            observability.LogFormat(cfg.Observability.LogFormat),
		LogLevel:             cfg.Observability.LogLevel,
		Pprof:                cfg.Observability.Pprof,
		RequestLogs:          observability.RequestLogMode(cfg.Observability.RequestLogs),
		RequestSampleRate:    cfg.Observability.RequestSampleRate,
		Service:              cfg.Observability.Service,
		SlowRequestThreshold: cfg.Observability.SlowRequestThreshold,
		TraceLogs:            cfg.Observability.TraceLogs,
		Version:              cfg.Observability.Version,
	}, os.Stdout)
	logger := diagnostics.Logger()
	logger.Info("api starting",
		"event", "api.starting",
		"address", cfg.API.Address,
		"log_format", cfg.Observability.LogFormat,
		"log_level", cfg.Observability.LogLevel,
		"request_logs", cfg.Observability.RequestLogs,
		"trace_logs", cfg.Observability.TraceLogs,
		"pprof", cfg.Observability.Pprof,
	)

	pool, err := postgres.Open(context.Background(), cfg.Database)
	if err != nil {
		return fmt.Errorf("open postgres: %w", err)
	}
	defer pool.Close()
	logger.Info("postgres connected", "event", "postgres.connected")

	queries := postgresdb.New(pool)
	tenantRepository := postgres.NewTenantRepository(diagnostics.Queries(queries))
	tenantService := tenants.NewService(tenantRepository)
	routerOptions := httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: cfg.API.CORSAllowedOrigins,
		},
		Readiness: postgres.Readiness{Pool: pool},
		Tenants:   tenantService,
	}
	diagnostics.ApplyHTTP(&routerOptions)

	handler := httpapi.NewRouter(routerOptions)

	server := &http.Server{
		Addr:              cfg.API.Address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("api listening", "event", "api.listening", "address", cfg.API.Address)

		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("api listen failed", "event", "api.listen_failed", "error", err.Error())
			serverErr <- err
			return
		}

		serverErr <- nil
	}()

	select {
	case err := <-serverErr:
		return err
	case <-signalCtx.Done():
		stop()
	}

	shutdownStartedAt := time.Now()
	logger.Info("api shutdown requested", "event", "api.shutdown_requested")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("api shutdown failed", "event", "api.shutdown_failed", "error", err.Error())
		return fmt.Errorf("shutdown server: %w", err)
	}

	logger.Info("api shutdown complete",
		"event", "api.shutdown_complete",
		"duration_ms", float64(time.Since(shutdownStartedAt).Microseconds())/1000,
	)
	return <-serverErr
}

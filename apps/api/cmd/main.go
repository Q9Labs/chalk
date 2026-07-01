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
		Pprof:     cfg.Observability.Pprof,
		TraceLogs: cfg.Observability.TraceLogs,
	}, os.Stdout)

	pool, err := postgres.Open(context.Background(), cfg.Database)
	if err != nil {
		return fmt.Errorf("open postgres: %w", err)
	}
	defer pool.Close()

	queries := postgresdb.New(pool)
	tenantStore := postgres.NewTenantStore(diagnostics.Queries(queries))
	tenantService := tenants.NewService(tenantStore)

	routerOptions := httpapi.Options{
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
		fmt.Printf("api listening on %s\n", cfg.API.Address)

		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
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

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown server: %w", err)
	}

	return <-serverErr
}

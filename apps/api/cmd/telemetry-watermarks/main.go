// telemetry-watermarks prints what the telemetry ledger knows of one Episode: for each source, its
// watermark and the seq ranges it cannot account for. It is read-only, and diagnose (scripts/diagnose-call/live)
// turns its output into evidence watermarks.
//
//	CHALK_DATABASE_URL=... telemetry-watermarks --tenant <uuid> --episode <uuid>
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "telemetry-watermarks:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("telemetry-watermarks", flag.ContinueOnError)
	tenantArg := flags.String("tenant", "", "Tenant uuid")
	episodeArg := flags.String("episode", "", "Episode uuid")
	if err := flags.Parse(args); err != nil {
		return err
	}
	tenant, err := utilities.ParseID(*tenantArg)
	if err != nil {
		return fmt.Errorf("--tenant: %w", err)
	}
	episode, err := utilities.ParseID(*episodeArg)
	if err != nil {
		return fmt.Errorf("--episode: %w", err)
	}
	url := os.Getenv("CHALK_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		return errors.New("CHALK_DATABASE_URL (or DATABASE_URL) required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	poolConfig, err := pgxpool.ParseConfig(url)
	if err != nil {
		return errors.New("invalid database configuration")
	}
	poolConfig.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return errors.New("open telemetry ledger database")
	}
	defer pool.Close()
	result, err := telemetrydelivery.EpisodeReport(ctx, postgres.NewTelemetryLedger(pool), tenant, episode)
	if err != nil {
		return redacted(err)
	}
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", " ")
	return encoder.Encode(result)
}

// redacted keeps the database's user, name and host out of an error: pgx names all three when the
// first read fails to connect, and diagnose prints the error.
func redacted(err error) error {
	var connect *pgconn.ConnectError
	if errors.As(err, &connect) {
		return errors.New("connect to the telemetry ledger database failed")
	}
	return err
}

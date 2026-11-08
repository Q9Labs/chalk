// media-provider-inventory counts Tenants, Spaces, live Episodes and recording
// dependencies by media provider for the own-SFU cutover. It is read-only and
// prints sanitized counts: no identifiers, and counts of 1 to 4 print as "<5".
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "media-provider-inventory:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out, stderr io.Writer) error {
	flags := flag.NewFlagSet("media-provider-inventory", flag.ContinueOnError)
	allowed := flags.String("allowed-spaces", "", "the "+config.ChalkSFUAllowedSpaces+" value the API runs with: * or comma-separated Space IDs; empty for none. Defaults to that environment variable.")
	limit := flags.Duration("timeout", time.Minute, "whole-command deadline, at most 5 minutes")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *limit <= 0 || *limit > 5*time.Minute {
		return errors.New("--timeout must be in (0, 5m] and no positional arguments are allowed")
	}
	allowedValue, set := os.LookupEnv(config.ChalkSFUAllowedSpaces)
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "allowed-spaces" {
			allowedValue, set = *allowed, true
		}
	})
	if !set {
		return fmt.Errorf("state the allowlist the API runs with: pass --allowed-spaces or set %s (empty means none)", config.ChalkSFUAllowedSpaces)
	}
	list, err := parseAllowlist(allowedValue)
	if err != nil {
		return err
	}
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		return fmt.Errorf("%s required", config.DatabaseURL)
	}

	ctx, cancel := context.WithTimeout(ctx, *limit)
	defer cancel()
	raw, err := inventory(ctx, url, list, *limit)
	if err != nil {
		return err
	}
	report := newReport(raw, list)
	if err := report.writeJSON(out); err != nil {
		return err
	}
	return report.writeTable(stderr)
}

// inventory counts inside one read-only repeatable-read transaction, so every
// count comes from the same snapshot and nothing can be written.
func inventory(ctx context.Context, url string, list allowlist, limit time.Duration) (rawReport, error) {
	connection, err := pgx.Connect(ctx, url)
	if err != nil {
		return rawReport{}, errors.New("open database")
	}
	defer connection.Close(context.Background())
	tx, err := connection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return rawReport{}, fmt.Errorf("begin read-only transaction: %w", err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, fmt.Sprintf("set local statement_timeout = %d", limit.Milliseconds())); err != nil {
		return rawReport{}, fmt.Errorf("set statement timeout: %w", err)
	}
	return collect(ctx, tx, list)
}

// tenant-purge is an operator-only command. Its default is read-only inventory.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
)

type options struct {
	operation, scope, plan, planOut, backfill, objects, backup, result, journal, backupRefresh string
	baseline, target, beforeImages                                                             string
	apply, dryRun, export                                                                      bool
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "tenant-purge:", err)
		os.Exit(1)
	}
}

var operations = []string{"purge", "backfill", "cleanup", "purge-short", "backfill-short", "cleanup-short"}

func parseOptions() (options, error) {
	var o options
	flag.StringVar(&o.operation, "operation", "purge", "purge, backfill, or cleanup")
	flag.StringVar(&o.baseline, "baseline-plan", "", "restore-verified pre-purge baseline plan")
	flag.StringVar(&o.target, "tenant-id", "", "one exact approved Tenant for purge-short")
	flag.StringVar(&o.beforeImages, "before-images-directory", "", "owner-only encrypted backup directory outside Git")
	flag.StringVar(&o.scope, "scope", "", "private exact identity partition JSON")
	flag.StringVar(&o.plan, "plan", "", "private previously inventoried plan")
	flag.StringVar(&o.planOut, "plan-out", "", "create a private keys/counts plan")
	flag.StringVar(&o.backfill, "backfill", "", "explicit Space candidates and service exclusions JSON")
	flag.StringVar(&o.objects, "objects", "", "explicit backed-up storage object manifest JSON")
	flag.StringVar(&o.backup, "backup-receipt", "", "restore-verified encrypted backup receipt")
	flag.StringVar(&o.backupRefresh, "backup-refresh-command", "", "private executable: frozen before-images on stdin, verified backup receipt on stdout")
	flag.StringVar(&o.result, "result-out", "", "create private relational commit receipt")
	flag.StringVar(&o.journal, "journal", "", "private append-only object cleanup journal")
	flag.BoolVar(&o.apply, "apply", false, "apply only an approved plan with verified backup")
	flag.BoolVar(&o.dryRun, "dry-run", false, "read-only (also the default)")
	flag.BoolVar(&o.export, "export", false, "stream affected before-images for encrypted backup; NEVER log this stream")
	flag.Parse()
	switch {
	case flag.NArg() != 0 || o.apply && (o.dryRun || o.export) || o.backupRefresh != "" && (!o.apply || o.operation != "purge"):
		return o, errors.New("invalid argument combination")
	case !slices.Contains(operations, o.operation):
		return o, errors.New("unknown operation")
	case o.export && o.planOut == "":
		return o, errors.New("backup export requires a matching plan-out")
	}
	return o, nil
}

func run() error {
	o, err := parseOptions()
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	url := os.Getenv("CHALK_DATABASE_URL")
	if url == "" {
		return errors.New("CHALK_DATABASE_URL required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	repository := postgres.NewTenantPurgeRepository(pool)
	switch {
	case strings.HasSuffix(o.operation, "-short"):
		return runShort(ctx, repository, o)
	case o.apply || o.operation == "cleanup":
		return applyApproved(ctx, repository, o)
	default:
		return inventory(ctx, repository, o)
	}
}

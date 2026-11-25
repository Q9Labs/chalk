// tenant-handover is an operator-only command for starting or cancelling a Tenant handover.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/tenanthandovers"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "tenant-handover:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return errors.New("operation required: start or cancel")
	}
	operation := os.Args[1]
	flags := flag.NewFlagSet(operation, flag.ContinueOnError)
	tenant := flags.String("tenant-id", "", "Tenant ID")
	handover := flags.String("handover-id", "", "Tenant handover ID")
	email := flags.String("email", "", "recipient email")
	operator := flags.String("operator", "", "operator identity recorded in the handover audit")
	requestKey := flags.String("request-key", "", "idempotency request key for start")
	expiresIn := flags.Int64("expires-in-seconds", tenanthandovers.DefaultExpiresInSeconds, "offer lifetime in seconds")
	if err := flags.Parse(os.Args[2:]); err != nil || flags.NArg() != 0 {
		return errors.New("invalid arguments")
	}
	if *operator == "" {
		return errors.New("operator required")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.API.ServicePrincipal.ID == "" {
		return errors.New("dashboard service ID is not configured")
	}
	url := os.Getenv("CHALK_DATABASE_URL")
	if url == "" {
		return errors.New("CHALK_DATABASE_URL required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	service := tenanthandovers.NewService(postgres.NewTenantHandoverRepository(pool))
	actor := tenanthandovers.Actor{Kind: tenanthandovers.ActorOperator, Operator: *operator}
	var result any
	switch operation {
	case "start":
		tenantID, err := utilities.ParseID(*tenant)
		if err != nil {
			return errors.New("valid tenant-id required")
		}
		created, err := service.Create(ctx, tenanthandovers.CreateInput{TenantID: tenantID, RecipientEmail: *email, ExpiresInSeconds: *expiresIn, RequestKey: *requestKey, ToServiceID: cfg.API.ServicePrincipal.ID, Actor: actor})
		if err != nil {
			return err
		}
		result = created.Handover
	case "cancel":
		tenantID, err := utilities.ParseID(*tenant)
		if err != nil {
			return errors.New("valid tenant-id required")
		}
		handoverID, err := utilities.ParseID(*handover)
		if err != nil {
			return errors.New("valid handover-id required")
		}
		result, err = service.Cancel(ctx, tenanthandovers.CancelInput{TenantID: tenantID, HandoverID: handoverID, Actor: actor})
		if err != nil {
			return err
		}
	default:
		return errors.New("unknown operation")
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

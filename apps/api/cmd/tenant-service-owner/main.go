// tenant-service-owner is an operator-only, audited Tenant adoption command.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Getenv("CHALK_DATABASE_URL"), os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "tenant-service-owner:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, databaseURL string, output io.Writer) error {
	flags := flag.NewFlagSet("tenant-service-owner", flag.ContinueOnError)
	tenantID := flags.String("tenant-id", "", "existing Tenant ID")
	serviceID := flags.String("service-id", "", "stable service ID (not a secret)")
	externalID := flags.String("external-id", "", "optional external account ID")
	actor := flags.String("actor", "", "operator identity for the audit record")
	reason := flags.String("reason", "", "reason for assigning ownership")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	id, err := utilities.ParseID(*tenantID)
	if err != nil {
		return tenants.ErrInvalidTenantID
	}
	input := tenants.AdoptServiceInput{TenantID: id, ServiceID: *serviceID, Actor: *actor, Reason: *reason}
	if *externalID != "" {
		input.ExternalID = externalID
	}
	if err := input.Validate(); err != nil {
		return err
	}
	if databaseURL == "" {
		return errors.New("CHALK_DATABASE_URL required (direct owner connection)")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	auditID, err := postgres.AdoptServiceTenant(ctx, sqlc.New(pool), input)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "Tenant %s is owned by service %s; audit record %d\n", id.String(), *serviceID, auditID)
	return err
}

package observability

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestAccountTenantQueryTelemetryCoversListReservationAndReplay(t *testing.T) {
	queries := &accountTenantOperationQueries{}
	var output bytes.Buffer
	observed := OperationQueries(queries, slog.New(slog.NewJSONHandler(&output, nil)))
	ctx := context.Background()

	if _, err := observed.ListAccountTenants(ctx, sqlc.ListAccountTenantsParams{}); err != nil {
		t.Fatal(err)
	}
	if _, err := observed.ReserveTenantOnboarding(ctx, sqlc.ReserveTenantOnboardingParams{}); err != nil {
		t.Fatal(err)
	}
	if _, err := observed.GetTenantOnboarding(ctx, sqlc.GetTenantOnboardingParams{}); err != nil {
		t.Fatal(err)
	}
	if _, err := observed.GetAccountTenantByOnboarding(ctx, sqlc.GetAccountTenantByOnboardingParams{}); err != nil {
		t.Fatal(err)
	}

	logged := output.String()
	for _, operation := range []string{"ListAccountTenants", "ReserveTenantOnboarding", "GetTenantOnboarding", "GetAccountTenantByOnboarding"} {
		if !strings.Contains(logged, `"name":"`+operation+`"`) {
			t.Fatalf("log missing %s: %s", operation, logged)
		}
	}
}

type accountTenantOperationQueries struct {
	sqlc.Querier
}

func (*accountTenantOperationQueries) ListAccountTenants(context.Context, sqlc.ListAccountTenantsParams) ([]sqlc.ListAccountTenantsRow, error) {
	return nil, nil
}

func (*accountTenantOperationQueries) ReserveTenantOnboarding(context.Context, sqlc.ReserveTenantOnboardingParams) (sqlc.TenantOnboardingRequest, error) {
	return sqlc.TenantOnboardingRequest{}, nil
}

func (*accountTenantOperationQueries) GetTenantOnboarding(context.Context, sqlc.GetTenantOnboardingParams) (sqlc.TenantOnboardingRequest, error) {
	return sqlc.TenantOnboardingRequest{}, nil
}

func (*accountTenantOperationQueries) GetAccountTenantByOnboarding(context.Context, sqlc.GetAccountTenantByOnboardingParams) (sqlc.GetAccountTenantByOnboardingRow, error) {
	return sqlc.GetAccountTenantByOnboardingRow{}, nil
}

package postgres

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"os"
	"testing"
)

func accountTenantIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func accountTenantIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

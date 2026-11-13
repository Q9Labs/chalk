package main

import (
	"context"
	"maps"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func shown(f Family) map[string]string {
	result := map[string]string{}
	for key, cell := range f {
		result[key] = cell.String()
	}
	return result
}

func testDatabaseURL() string {
	for _, name := range []string{"CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL", config.DatabaseURL} {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return config.DefaultDatabaseURL
}

func connect(t *testing.T) (context.Context, *pgx.Conn) {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	connection, err := pgx.Connect(ctx, testDatabaseURL())
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(func() { connection.Close(context.Background()) })
	// The counts here break when another package commits Tenants or Spaces meanwhile
	// (media-settings does). Closing the connection releases the lock.
	if _, err := connection.Exec(ctx, `select pg_advisory_lock(7710001)`); err != nil {
		t.Fatal(err)
	}
	return ctx, connection
}

func newID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func delta(after, before counts) counts {
	result := counts{}
	for key, n := range after {
		if d := n - before[key]; d != 0 {
			result[key] = d
		}
	}
	return result
}

func expectCounts(t *testing.T, name string, got, want counts) {
	t.Helper()
	if !maps.Equal(got, want) {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

const (
	tenantManagedCloudflare = `{"enabled":true,"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"account_id":"a","sfu":{"enabled":true,"app_id":"i","app_secret":"s"}}}`
	chalkManaged            = `{"enabled":true,"mode":"chalk_managed"}`
	disabledConfig          = `{"enabled":false,"mode":"chalk_managed"}`
)

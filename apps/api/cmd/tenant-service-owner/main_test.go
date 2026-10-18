package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestOperatorCommandAdoptsExistingTenantAndAuditsActor(t *testing.T) {
	databaseURL := os.Getenv("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL is not set")
	}
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service := tenants.NewService(postgres.NewTenantRepository(sqlc.New(pool)))
	tenant, err := service.CreateTenant(ctx, tenants.CreateTenantInput{Name: "Existing operator Tenant"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, query := range []string{`delete from tenant_service_ownership_audit where tenant_id=$1`, `delete from tenants where id=$1`} {
			if _, err := pool.Exec(context.Background(), query, tenant.ID.String()); err != nil {
				t.Error(err)
			}
		}
	})
	id := tenant.ID.String()
	serviceID := "operator-service-" + id
	args := []string{"--tenant-id", id, "--service-id", serviceID, "--external-id", "workos:test:" + id, "--actor", "test-operator", "--reason", "account takeover requested"}
	var output bytes.Buffer
	if err := run(ctx, args, databaseURL, &output); err != nil {
		t.Fatal(err)
	}
	if output.Len() == 0 {
		t.Fatal("command omitted audit receipt")
	}
	var actor, reason, owner, external string
	var previousOwner, previousExternal *string
	err = pool.QueryRow(ctx, `select a.actor,a.reason,t.created_by_service_id,t.external_id,a.previous_service_id,a.previous_external_id from tenant_service_ownership_audit a join tenants t on t.id=a.tenant_id where t.id=$1`, id).Scan(&actor, &reason, &owner, &external, &previousOwner, &previousExternal)
	if err != nil || actor != "test-operator" || reason != "account takeover requested" || owner != serviceID || external != "workos:test:"+id || previousOwner != nil || previousExternal != nil {
		t.Fatalf("audit/ownership mismatch: %s %s %s %s %v %v, %v", actor, reason, owner, external, previousOwner, previousExternal, err)
	}
	found, err := service.FindServiceTenant(ctx, serviceID, "workos:test:"+id)
	if err != nil || found.ID != tenant.ID {
		t.Fatalf("adopted Tenant lookup: %+v, %v", found, err)
	}
	args[3] = "different-service-" + id
	if err := run(ctx, args, databaseURL, &output); err == nil {
		t.Fatal("command transferred a different service's Tenant")
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from tenant_service_ownership_audit where tenant_id=$1`, id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed adoption wrote audit: count=%d, %v", count, err)
	}
	if err := run(ctx, []string{"--tenant-id", id, "--service-id", serviceID, "--reason", "missing actor"}, databaseURL, &output); err == nil {
		t.Fatal("command accepted missing actor")
	}
	// Repeating the account callback returns the adopted Tenant, never a new owner.
	repeated, err := service.CreateTenant(ctx, tenants.CreateTenantInput{Name: "Ignored replacement", CreatedByServiceID: &serviceID, ExternalID: &external})
	if err != nil || repeated.ID != tenant.ID || repeated.Name != tenant.Name {
		t.Fatalf("adoption/find-or-create changed Tenant: %s, %v", fmt.Sprint(repeated), err)
	}
}

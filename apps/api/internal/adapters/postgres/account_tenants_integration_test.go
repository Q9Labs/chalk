package postgres

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAccountTenantOnboardingIsAtomicScopedAndIdempotent(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := context.Background()
	accountID := accountTenantIntegrationID(t)
	otherAccountID := accountTenantIntegrationID(t)
	for _, account := range []struct {
		id   utilities.ID
		name string
	}{{accountID, "Dashboard owner"}, {otherAccountID, "Other Account"}} {
		if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,$2,$3)`, uuid(account.id), account.name, account.id.String()+"@account.test"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from tenant_onboarding_requests where account_id in ($1,$2)`, uuid(accountID), uuid(otherAccountID))
		pool.Exec(ctx, `delete from memberships where user_id in ($1,$2)`, uuid(accountID), uuid(otherAccountID))
		pool.Exec(ctx, `delete from tenants where name in ('Atomic studio','Changed studio','Must roll back')`)
		pool.Exec(ctx, `delete from users where id in ($1,$2)`, uuid(accountID), uuid(otherAccountID))
	})

	repository := NewAccountTenantRepository(sqlc.New(pool), pool, nil)
	service := tenants.NewAccountService(repository)
	input := tenants.OnboardTenantInput{AccountID: accountID, RequestKey: "tenant-onboard-integration-0001", Name: " Atomic studio "}

	first, err := service.OnboardTenant(ctx, input)
	if err != nil {
		t.Fatalf("first onboarding: %v", err)
	}
	second, err := service.OnboardTenant(ctx, input)
	if err != nil {
		t.Fatalf("replay onboarding: %v", err)
	}
	if first.Replayed || !second.Replayed || first.AccountTenant.Tenant.ID != second.AccountTenant.Tenant.ID || first.AccountTenant.Access.ID != second.AccountTenant.Access.ID {
		t.Fatalf("idempotency first=%#v second=%#v", first, second)
	}
	if first.AccountTenant.Access.Role != "owner" || first.AccountTenant.Access.AccountID != accountID {
		t.Fatalf("owner access = %#v", first.AccountTenant.Access)
	}

	_, err = service.OnboardTenant(ctx, tenants.OnboardTenantInput{AccountID: accountID, RequestKey: input.RequestKey, Name: "Changed studio"})
	if !errors.Is(err, tenants.ErrIdempotencyConflict) {
		t.Fatalf("conflicting replay error = %v", err)
	}
	page, err := pagination.NewPageRequest(25, nil)
	if err != nil {
		t.Fatal(err)
	}
	ownerList, err := service.ListAccountTenants(ctx, accountID, page)
	if err != nil || len(ownerList.Tenants) != 1 {
		t.Fatalf("owner list = %#v, err = %v", ownerList, err)
	}
	otherList, err := service.ListAccountTenants(ctx, otherAccountID, page)
	if err != nil || len(otherList.Tenants) != 0 {
		t.Fatalf("other account list = %#v, err = %v", otherList, err)
	}

	missingAccountID := accountTenantIntegrationID(t)
	_, err = service.OnboardTenant(ctx, tenants.OnboardTenantInput{AccountID: missingAccountID, RequestKey: "tenant-onboard-integration-rollback", Name: "Must roll back"})
	if err == nil {
		t.Fatal("onboarding unexpectedly succeeded for missing Account")
	}
	var rolledBack int
	if err := pool.QueryRow(ctx, `select count(*) from tenants where name='Must roll back'`).Scan(&rolledBack); err != nil || rolledBack != 0 {
		t.Fatalf("rolled-back tenant count = %d, err = %v", rolledBack, err)
	}
}

func TestConcurrentTenantOnboardingConvergesOnOneTenant(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := context.Background()
	accountID := accountTenantIntegrationID(t)
	if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Concurrent owner',$2)`, uuid(accountID), accountID.String()+"@account.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from tenant_onboarding_requests where account_id=$1`, uuid(accountID))
		pool.Exec(ctx, `delete from memberships where user_id=$1`, uuid(accountID))
		pool.Exec(ctx, `delete from tenants where name='Concurrent studio'`)
		pool.Exec(ctx, `delete from users where id=$1`, uuid(accountID))
	})
	service := tenants.NewAccountService(NewAccountTenantRepository(sqlc.New(pool), pool, nil))
	input := tenants.OnboardTenantInput{AccountID: accountID, RequestKey: "tenant-onboard-concurrent-0001", Name: "Concurrent studio"}

	results := make([]tenants.OnboardTenantResult, 2)
	errorsFound := make([]error, 2)
	var wait sync.WaitGroup
	for index := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results[index], errorsFound[index] = service.OnboardTenant(ctx, input)
		}()
	}
	wait.Wait()
	for _, err := range errorsFound {
		if err != nil {
			t.Fatalf("concurrent onboarding: %v", err)
		}
	}
	if results[0].AccountTenant.Tenant.ID != results[1].AccountTenant.Tenant.ID || results[0].Replayed == results[1].Replayed {
		t.Fatalf("concurrent results = %#v", results)
	}
}

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

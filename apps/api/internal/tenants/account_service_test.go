package tenants_test

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type accountTenantRepository struct {
	list    func(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error)
	onboard func(context.Context, tenants.OnboardTenantRecordInput) (tenants.OnboardTenantResult, error)
}

func (r accountTenantRepository) ListAccountTenants(ctx context.Context, accountID utilities.ID, page pagination.PageRequest) (tenants.AccountTenantList, error) {
	return r.list(ctx, accountID, page)
}

func (r accountTenantRepository) OnboardTenant(ctx context.Context, input tenants.OnboardTenantRecordInput) (tenants.OnboardTenantResult, error) {
	return r.onboard(ctx, input)
}

func TestAccountServiceOnboardsNormalizedTenantWithStableFingerprint(t *testing.T) {
	accountID := mustAccountID(t, "11111111-1111-4111-8111-111111111111")
	var first tenants.OnboardTenantRecordInput
	repository := accountTenantRepository{onboard: func(_ context.Context, input tenants.OnboardTenantRecordInput) (tenants.OnboardTenantResult, error) {
		if first.AccountID.IsZero() {
			first = input
		} else if first.RequestFingerprint != input.RequestFingerprint {
			t.Fatal("equivalent normalized requests produced different fingerprints")
		}
		return tenants.OnboardTenantResult{}, nil
	}}
	service := tenants.NewAccountService(repository)

	for _, name := range []string{"  Acme studio  ", "Acme studio"} {
		_, err := service.OnboardTenant(context.Background(), tenants.OnboardTenantInput{
			AccountID: accountID, RequestKey: "tenant-onboard-0001", Name: name,
		})
		if err != nil {
			t.Fatalf("onboard tenant: %v", err)
		}
	}
	if first.AccountID != accountID || first.RequestKey != "tenant-onboard-0001" {
		t.Fatalf("record identity = (%s, %q)", first.AccountID.String(), first.RequestKey)
	}
	if first.Tenant.Name != "Acme studio" || first.Tenant.ID.IsZero() || first.AccessID.IsZero() {
		t.Fatalf("normalized record = %#v", first)
	}
}

func TestAccountServiceOnboardingDefaultsManagedMediaPlaneAndPreservesReplay(t *testing.T) {
	accountID := mustAccountID(t, "11111111-1111-4111-8111-111111111111")
	var records []tenants.OnboardTenantRecordInput
	repository := accountTenantRepository{onboard: func(_ context.Context, input tenants.OnboardTenantRecordInput) (tenants.OnboardTenantResult, error) {
		records = append(records, input)
		return tenants.OnboardTenantResult{Replayed: len(records) > 1}, nil
	}}
	service := tenants.NewAccountService(repository)
	input := tenants.OnboardTenantInput{
		AccountID:  accountID,
		RequestKey: "tenant-onboard-media-plane-01",
		Name:       "Managed studio",
	}

	first, err := service.OnboardTenant(context.Background(), input)
	if err != nil {
		t.Fatalf("first onboarding: %v", err)
	}
	second, err := service.OnboardTenant(context.Background(), input)
	if err != nil {
		t.Fatalf("replayed onboarding: %v", err)
	}
	if first.Replayed || !second.Replayed {
		t.Fatalf("replay flags = first %v, second %v", first.Replayed, second.Replayed)
	}
	if len(records) != 2 {
		t.Fatalf("repository calls = %d, want 2", len(records))
	}
	for index, record := range records {
		if record.Tenant.DefaultMediaPlane == nil || *record.Tenant.DefaultMediaPlane != "cf_rtk" {
			t.Fatalf("record %d default media plane = %v, want cf_rtk", index, record.Tenant.DefaultMediaPlane)
		}
		if !bytes.Equal(record.Tenant.MediaPlaneProviderConfig, []byte(`{"enabled":true,"provider":"cf_rtk","mode":"chalk_managed"}`)) {
			t.Fatalf("record %d provider config = %s", index, record.Tenant.MediaPlaneProviderConfig)
		}
	}
	if records[0].RequestFingerprint != records[1].RequestFingerprint {
		t.Fatal("replay changed the normalized request fingerprint")
	}
}

func TestAccountServiceRejectsInvalidOnboardingInputBeforeRepository(t *testing.T) {
	called := false
	service := tenants.NewAccountService(accountTenantRepository{onboard: func(context.Context, tenants.OnboardTenantRecordInput) (tenants.OnboardTenantResult, error) {
		called = true
		return tenants.OnboardTenantResult{}, nil
	}})

	_, err := service.OnboardTenant(context.Background(), tenants.OnboardTenantInput{
		AccountID: mustAccountID(t, "11111111-1111-4111-8111-111111111111"), RequestKey: "short", Name: "Acme",
	})
	if !errors.Is(err, tenants.ErrInvalidRequestKey) {
		t.Fatalf("error = %v, want invalid request key", err)
	}
	if called {
		t.Fatal("repository called for invalid request")
	}
}

func TestAccountServiceListRejectsMissingAccount(t *testing.T) {
	service := tenants.NewAccountService(accountTenantRepository{list: func(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error) {
		t.Fatal("repository called for invalid account")
		return tenants.AccountTenantList{}, nil
	}})
	page, err := pagination.NewPageRequest(25, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.ListAccountTenants(context.Background(), utilities.ID{}, page)
	if !errors.Is(err, tenants.ErrInvalidAccountID) {
		t.Fatalf("error = %v, want invalid account", err)
	}
}

func mustAccountID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

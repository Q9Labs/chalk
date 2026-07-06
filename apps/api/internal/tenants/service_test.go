package tenants_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestServiceGetTenant(t *testing.T) {
	id := mustTenantID(t, "11111111-1111-1111-1111-111111111111")
	repository := &tenantRepository{
		tenant: tenants.Tenant{
			ID:   id,
			Name: "Acme",
		},
	}
	service := tenants.NewService(repository)

	tenant, err := service.GetTenant(context.Background(), id)
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}

	if tenant.ID.String() != id.String() {
		t.Fatalf("tenant id = %q, want %q", tenant.ID.String(), id.String())
	}
	if repository.requestedID.String() != id.String() {
		t.Fatalf("requested id = %q, want %q", repository.requestedID.String(), id.String())
	}
}

func TestServiceCreateTenant(t *testing.T) {
	repository := &tenantRepository{}
	service := tenants.NewService(repository)
	defaultRegion := " us "

	tenant, err := service.CreateTenant(context.Background(), tenants.CreateTenantInput{
		Name:          " Acme ",
		DefaultRegion: &defaultRegion,
	})
	if err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	if tenant.ID.IsZero() {
		t.Fatal("tenant id was not generated")
	}
	if repository.createInput.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", repository.createInput.Name)
	}
	if repository.createInput.DefaultRegion == nil || *repository.createInput.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", repository.createInput.DefaultRegion)
	}
}

func TestServiceCreateTenantRejectsInvalidRegion(t *testing.T) {
	repository := &tenantRepository{}
	service := tenants.NewService(repository)
	defaultRegion := "mars"

	_, err := service.CreateTenant(context.Background(), tenants.CreateTenantInput{
		Name:          "Acme",
		DefaultRegion: &defaultRegion,
	})
	if !errors.Is(err, tenants.ErrInvalidTenantRegion) {
		t.Fatalf("error = %v, want %v", err, tenants.ErrInvalidTenantRegion)
	}
	if repository.called {
		t.Fatal("repository was called")
	}
}

func TestServiceGetTenantRejectsZeroID(t *testing.T) {
	repository := &tenantRepository{}
	service := tenants.NewService(repository)

	_, err := service.GetTenant(context.Background(), utilities.ID{})
	if !errors.Is(err, tenants.ErrInvalidTenantID) {
		t.Fatalf("error = %v, want %v", err, tenants.ErrInvalidTenantID)
	}
	if repository.called {
		t.Fatal("repository was called")
	}
}

func TestServiceUpdateTenant(t *testing.T) {
	id := mustTenantID(t, "11111111-1111-1111-1111-111111111111")
	repository := &tenantRepository{}
	service := tenants.NewService(repository)
	name := " Acme Labs "
	defaultRegion := "sg"

	_, err := service.UpdateTenant(context.Background(), id, tenants.UpdateTenantInput{
		Name: utilities.OptionalString{
			Set:   true,
			Value: &name,
		},
		DefaultRegion: utilities.OptionalString{
			Set:   true,
			Value: &defaultRegion,
		},
	})
	if err != nil {
		t.Fatalf("update tenant: %v", err)
	}

	if repository.requestedID.String() != id.String() {
		t.Fatalf("requested id = %q, want %q", repository.requestedID.String(), id.String())
	}
	if repository.updateInput.Name.Value == nil || *repository.updateInput.Name.Value != "Acme Labs" {
		t.Fatalf("name = %v, want Acme Labs", repository.updateInput.Name.Value)
	}
	if repository.updateInput.DefaultRegion.Value == nil || *repository.updateInput.DefaultRegion.Value != "sg" {
		t.Fatalf("default region = %v, want sg", repository.updateInput.DefaultRegion.Value)
	}
}

func TestServiceUpdateTenantAllowsClearingRegion(t *testing.T) {
	id := mustTenantID(t, "11111111-1111-1111-1111-111111111111")
	repository := &tenantRepository{}
	service := tenants.NewService(repository)

	_, err := service.UpdateTenant(context.Background(), id, tenants.UpdateTenantInput{
		DefaultRegion: utilities.OptionalString{Set: true},
	})
	if err != nil {
		t.Fatalf("update tenant: %v", err)
	}

	if !repository.updateInput.DefaultRegion.Set {
		t.Fatal("default region was not marked as set")
	}
	if repository.updateInput.DefaultRegion.Value != nil {
		t.Fatalf("default region = %v, want nil", repository.updateInput.DefaultRegion.Value)
	}
}

func TestServiceUpdateTenantRejectsInvalidRegion(t *testing.T) {
	id := mustTenantID(t, "11111111-1111-1111-1111-111111111111")
	repository := &tenantRepository{}
	service := tenants.NewService(repository)
	defaultRegion := "mars"

	_, err := service.UpdateTenant(context.Background(), id, tenants.UpdateTenantInput{
		DefaultRegion: utilities.OptionalString{
			Set:   true,
			Value: &defaultRegion,
		},
	})
	if !errors.Is(err, tenants.ErrInvalidTenantRegion) {
		t.Fatalf("error = %v, want %v", err, tenants.ErrInvalidTenantRegion)
	}
	if repository.called {
		t.Fatal("repository was called")
	}
}

func TestServiceAvailableRegions(t *testing.T) {
	service := tenants.NewService(&tenantRepository{})

	regions, err := service.AvailableRegions(context.Background())
	if err != nil {
		t.Fatalf("available regions: %v", err)
	}

	if len(regions) != 2 {
		t.Fatalf("region count = %d, want 2", len(regions))
	}
	if regions[0].Code != "us" || regions[1].Code != "sg" {
		t.Fatalf("regions = %#v, want us and sg", regions)
	}
}

func TestServiceGetTenantReturnsRepositoryError(t *testing.T) {
	want := errors.New("repository failed")
	service := tenants.NewService(&tenantRepository{err: want})

	_, err := service.GetTenant(context.Background(), mustTenantID(t, "11111111-1111-1111-1111-111111111111"))
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

type tenantRepository struct {
	called      bool
	requestedID utilities.ID
	tenant      tenants.Tenant
	createInput tenants.CreateTenantInput
	updateInput tenants.UpdateTenantInput
	err         error
}

func (r *tenantRepository) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	r.called = true
	r.createInput = input

	if r.err != nil {
		return tenants.Tenant{}, r.err
	}

	return tenants.Tenant{
		ID:                input.ID,
		Name:              input.Name,
		DefaultRegion:     input.DefaultRegion,
		DefaultMediaPlane: input.DefaultMediaPlane,
		LogoKey:           input.LogoKey,
		Website:           input.Website,
	}, nil
}

func (r *tenantRepository) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	r.called = true
	r.requestedID = id

	if r.err != nil {
		return tenants.Tenant{}, r.err
	}

	return r.tenant, nil
}

func (r *tenantRepository) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	r.called = true

	if r.err != nil {
		return tenants.TenantList{}, r.err
	}

	return tenants.TenantList{
		Page: pagination.Page{PageSize: page.Size()},
	}, nil
}

func (r *tenantRepository) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	r.called = true
	r.requestedID = id
	r.updateInput = input

	if r.err != nil {
		return tenants.Tenant{}, r.err
	}

	return tenants.Tenant{
		ID:   id,
		Name: "Acme",
	}, nil
}

func mustTenantID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}

package tenants

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type writingRepository struct {
	TenantRepository
	created CreateTenantInput
	updated UpdateTenantInput
	writes  int
}

func (r *writingRepository) CreateTenant(_ context.Context, input CreateTenantInput) (Tenant, error) {
	r.created = input
	r.writes++
	return Tenant{}, nil
}

func (r *writingRepository) UpdateTenant(_ context.Context, _ utilities.ID, input UpdateTenantInput) (Tenant, error) {
	r.updated = input
	r.writes++
	return Tenant{}, nil
}

func text(s string) *string { return &s }

func gatedService(repository TenantRepository) Service {
	return NewService(repository).WithMediaPlanes(func(plane string) bool { return plane == "cf_sfu" }, func(plane string) bool { return plane == "cf_sfu" || plane == "chalk_sfu" })
}

func tenantID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPublicTenantWritesAcceptOnlyNullOrThePlatformDefault(t *testing.T) {
	cases := []struct {
		name  string
		plane *string
		want  error
	}{
		{"null inherits", nil, nil},
		{"the platform default", text("cf_sfu"), nil},
		{"the own SFU", text("chalk_sfu"), ErrMediaPlaneNotPermitted},
		{"an unknown string", text("bogus"), ErrInvalidTenantField},
	}
	for _, c := range cases {
		repository := &writingRepository{}
		_, err := gatedService(repository).UpdateTenant(context.Background(), tenantID(t), UpdateTenantInput{
			DefaultMediaPlane: utilities.OptionalString{Set: true, Value: c.plane},
		})
		if !errors.Is(err, c.want) {
			t.Errorf("update %s: got %v, want %v", c.name, err, c.want)
		}
		if refused := c.want != nil; refused && repository.writes != 0 {
			t.Errorf("update %s: a refused write reached the repository", c.name)
		}

		repository = &writingRepository{}
		_, err = gatedService(repository).CreateTenant(context.Background(), CreateTenantInput{Name: "Acme", DefaultMediaPlane: c.plane})
		if !errors.Is(err, c.want) {
			t.Errorf("create %s: got %v, want %v", c.name, err, c.want)
		}
	}
}

func TestPublicTenantWritesAcceptNoPlaneWithoutTheGate(t *testing.T) {
	_, err := NewService(&writingRepository{}).UpdateTenant(context.Background(), tenantID(t), UpdateTenantInput{
		DefaultMediaPlane: utilities.OptionalString{Set: true, Value: text("cf_sfu")},
	})
	if !errors.Is(err, ErrInvalidTenantField) {
		t.Fatalf("got %v, want a refusal when the service knows no plane", err)
	}
}

func TestOperatorSetsTheTenantPlaneThroughItsOwnPath(t *testing.T) {
	repository := &writingRepository{}
	if _, err := gatedService(repository).SetDefaultMediaPlane(context.Background(), tenantID(t), text("chalk_sfu")); err != nil {
		t.Fatal(err)
	}
	got := repository.updated.DefaultMediaPlane
	if !got.Set || got.Value == nil || *got.Value != "chalk_sfu" {
		t.Errorf("update = %+v", got)
	}
}

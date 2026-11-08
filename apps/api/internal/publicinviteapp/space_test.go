package publicinviteapp

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type countingSpaces struct {
	created int
}

func (s *countingSpaces) CreateSpace(context.Context, spaces.CreateSpaceInput) (spaces.Space, error) {
	s.created++
	return spaces.Space{}, nil
}

func (*countingSpaces) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}

type managedTenant struct{}

func (managedTenant) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

// A public call whose client the media plane refuses must not leave a Space,
// invite or arrival behind: the check runs before the Space is created.
func TestPublicSpaceIsNotCreatedForARefusedClient(t *testing.T) {
	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	store := &countingSpaces{}
	refusal := func(context.Context, tenants.Tenant, spaces.Space, mediaplane.ClientProviders) error {
		return mediaplane.ErrClientUnsupported
	}
	port, err := NewSpacePort(store, managedTenant{}, SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "chalk_sfu", RefuseClient: refusal})
	if err != nil {
		t.Fatal(err)
	}
	_, err = port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{DisplayName: "Hana", RequestKey: "client-sunset-space-0001"})
	if !errors.Is(err, mediaplane.ErrClientUnsupported) || store.created != 0 {
		t.Fatalf("error %v with %d Spaces created, want the refusal and none", err, store.created)
	}
}

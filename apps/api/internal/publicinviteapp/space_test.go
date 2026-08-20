package publicinviteapp_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSpacePortMapsCustomerSpaceAdmissionPolicy(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	spaceService := &spaceServiceStub{space: spaces.Space{
		ID:              spaceID,
		TenantID:        tenantID,
		Name:            "Customer Space",
		Slug:            "customer-space",
		Metadata:        json.RawMessage(`{"topic":"design"}`),
		AdmissionPolicy: json.RawMessage(`{"mode":"knock","limit":4}`),
	}}
	port, err := publicinviteapp.NewSpacePort(spaceService, tenantServiceStub{}, publicinviteapp.SpaceConfig{
		ManagedTenantID:   tenantID,
		DefaultMediaPlane: "cf_rtk",
	})
	if err != nil {
		t.Fatal(err)
	}

	got, err := port.GetPublicSpace(context.Background(), tenantID, spaceID)
	if err != nil {
		t.Fatal(err)
	}
	if got.TenantID != tenantID || got.SpaceID != spaceID || got.Name != "Customer Space" || got.Slug != "customer-space" || got.AdmissionMode != publicinvites.AdmissionKnock {
		t.Fatalf("public Space = %#v", got)
	}
}

func TestSpacePortCreatesIsolatedOpenSpaceWithConfiguredDefaults(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	spaceService := &spaceServiceStub{space: spaces.Space{ID: spaceID, TenantID: tenantID, Name: "Open Space", Slug: "public" + "-slug", AdmissionPolicy: json.RawMessage(`{"mode":"open"}`)}}
	port, err := publicinviteapp.NewSpacePort(spaceService, tenantServiceStub{}, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_sfu"})
	if err != nil {
		t.Fatal(err)
	}

	first, err := port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{DisplayName: "Open Space", RequestKey: "create-public-space-0001"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{DisplayName: "Open Space", RequestKey: "create-public-space-0001"})
	if err != nil {
		t.Fatal(err)
	}
	input := spaceService.created
	if input.TenantID != tenantID || input.MediaPlane != "cf_sfu" || input.DefaultEpisodeDurationSeconds != 3600 || input.MaximumEpisodeDurationSeconds != 3600 || input.LingerWindowSeconds != 0 || input.RequestKey != "create-public-space-0001" {
		t.Fatalf("create input = %#v", input)
	}
	if string(input.AdmissionPolicy) != `{"mode":"open"}` || string(input.Metadata) != `{}` || input.Slug == "" {
		t.Fatalf("create policy/defaults = %#v", input)
	}
	if first.SpaceID != spaceID || second.SpaceID != spaceID || first.Slug != second.Slug {
		t.Fatalf("created projection = %#v / %#v", first, second)
	}
}

func TestSpacePortPropagatesTenantAndSpaceErrors(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	backendErr := errors.New("backend unavailable")
	port, err := publicinviteapp.NewSpacePort(&spaceServiceStub{getErr: backendErr}, tenantServiceStub{}, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_sfu"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := port.GetPublicSpace(context.Background(), tenantID, spaceID); !errors.Is(err, backendErr) {
		t.Fatalf("space error = %v", err)
	}

	tenantErr := errors.New("tenant unavailable")
	port, err = publicinviteapp.NewSpacePort(&spaceServiceStub{}, tenantServiceStub{err: tenantErr}, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_sfu"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{DisplayName: "Space", RequestKey: "create-public-space-0001"}); !errors.Is(err, tenantErr) {
		t.Fatalf("tenant error = %v", err)
	}
}

func TestSpacePortRejectsInvalidCreateIdentity(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceService := &spaceServiceStub{space: spaces.Space{TenantID: tenantID, AdmissionPolicy: json.RawMessage(`{"mode":"open"}`)}}
	port, err := publicinviteapp.NewSpacePort(spaceService, tenantServiceStub{}, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_rtk"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{DisplayName: "Space", RequestKey: "short"}); !errors.Is(err, publicinvites.ErrInvalidRequestKey) {
		t.Fatalf("create error = %v, want invalid request key", err)
	}
	if spaceService.created.RequestKey != "" {
		t.Fatalf("space created for invalid request key: %#v", spaceService.created)
	}
}

func TestSpacePortRejectsArchivedOrMalformedCustomerSpace(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	archivedAt := time.Now()
	for _, test := range []struct {
		name  string
		space spaces.Space
		want  error
	}{
		{name: "malformed policy", space: spaces.Space{ID: spaceID, TenantID: tenantID, AdmissionPolicy: json.RawMessage(`{"mode"`)}, want: publicinvites.ErrInvalidInvite},
	} {
		t.Run(test.name, func(t *testing.T) {
			port, err := publicinviteapp.NewSpacePort(&spaceServiceStub{space: test.space}, tenantServiceStub{}, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_rtk"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := port.GetPublicSpace(context.Background(), tenantID, spaceID); !errors.Is(err, test.want) {
				t.Fatalf("get error = %v, want %v", err, test.want)
			}
		})
	}
	archivedPort, err := publicinviteapp.NewSpacePort(&spaceServiceStub{space: spaces.Space{ID: spaceID, TenantID: tenantID, ArchivedAt: &archivedAt, AdmissionPolicy: json.RawMessage(`{"mode":"open"}`)}}, tenantServiceStub{}, publicinviteapp.SpaceConfig{ManagedTenantID: tenantID, DefaultMediaPlane: "cf_rtk"})
	if err != nil {
		t.Fatal(err)
	}
	archived, err := archivedPort.GetPublicSpace(context.Background(), tenantID, spaceID)
	if err != nil {
		t.Fatal(err)
	}
	if !archived.Archived {
		t.Fatalf("archived projection = %#v", archived)
	}
}

type spaceServiceStub struct {
	space   spaces.Space
	created spaces.CreateSpaceInput
	getErr  error
}

func (s *spaceServiceStub) CreateSpace(_ context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	s.created = input
	return s.space, nil
}

func (s *spaceServiceStub) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	if s.getErr != nil {
		return spaces.Space{}, s.getErr
	}
	return s.space, nil
}

type tenantServiceStub struct {
	err error
}

func (s tenantServiceStub) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, s.err
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

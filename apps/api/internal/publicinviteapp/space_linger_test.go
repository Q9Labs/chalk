package publicinviteapp_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingSpaces struct {
	created []spaces.CreateSpaceInput
}

func (r *recordingSpaces) CreateSpace(_ context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	r.created = append(r.created, input)
	return spaces.Space{TenantID: input.TenantID, Name: input.Name, Slug: input.Slug, AdmissionPolicy: json.RawMessage(`{"mode":"open"}`)}, nil
}

func (r *recordingSpaces) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, spaces.ErrSpaceNotFound
}

type managedTenants struct{}

func (managedTenants) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

// A Start-a-call host who leaves and taps Rejoin a few seconds later must land in
// the same call. The Space's linger window is what keeps the Episode open for that
// quick return, so a Start-a-call Space must not be created with a zero window.
func TestStartACallSpaceKeepsLingerWindowForQuickRejoin(t *testing.T) {
	managedTenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceService := &recordingSpaces{}
	port, err := publicinviteapp.NewSpacePort(spaceService, managedTenants{}, publicinviteapp.SpaceConfig{
		ManagedTenantID:   managedTenantID,
		DefaultMediaPlane: "cf_sfu",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := port.CreatePublicSpace(context.Background(), publicinvites.CreatePublicSpaceInput{
		DisplayName: "Host",
		RequestKey:  "start-a-call-linger-request-key",
	}); err != nil {
		t.Fatal(err)
	}
	if len(spaceService.created) != 1 {
		t.Fatalf("created %d Spaces, want 1", len(spaceService.created))
	}
	if linger := spaceService.created[0].LingerWindowSeconds; linger <= 0 {
		t.Fatalf("Start-a-call Space linger window = %d seconds, want a window that keeps the call open for a quick Rejoin", linger)
	}
}

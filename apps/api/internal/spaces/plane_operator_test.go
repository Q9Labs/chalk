package spaces

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestOperatorCanReplaceALegacyTenantDefaultItCannotParse(t *testing.T) {
	tenantID, _ := ids(t)
	for _, plane := range []*MediaPlaneProvider{nil, planePtr(MediaPlaneProviderCloudflareSFU)} {
		store := &recordingTenantStore{tenant: tenants.Tenant{DefaultMediaPlane: stringPtr("bogus")}}
		change, err := NewPlaneOperator(&updatingRepository{}, store, PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU}).SetTenant(context.Background(), tenantID, plane)
		if err != nil {
			t.Fatalf("replacing a legacy value with %v: %v", plane, err)
		}
		if !store.written {
			t.Errorf("replacing with %v never reached the store", plane)
		}
		if change.Before == nil || *change.Before != "bogus" {
			t.Errorf("the audit line lost the raw legacy value: %v", change.Before)
		}
	}
}

type recordingTenantStore struct {
	tenant  tenants.Tenant
	written bool
}

func (s *recordingTenantStore) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return s.tenant, nil
}

func (s *recordingTenantStore) SetDefaultMediaPlane(context.Context, utilities.ID, *string) (tenants.Tenant, error) {
	s.written = true
	return s.tenant, nil
}

func TestOperatorSetsAndClearsASpace(t *testing.T) {
	tenantID, spaceID := ids(t)
	repository := &updatingRepository{space: Space{MediaPlaneSetting: planePtr(MediaPlaneProviderCloudflareSFU)}}
	operator := NewPlaneOperator(repository, tenantStore{}, PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU})

	change, err := operator.SetSpace(context.Background(), tenantID, spaceID, planePtr(MediaPlaneProviderChalkSFU))
	if err != nil {
		t.Fatal(err)
	}
	if change.Before == nil || *change.Before != "cf_sfu" || *change.After != "chalk_sfu" {
		t.Errorf("change = %+v", change)
	}
	if got := repository.updated; *got.MediaPlane.Value != "chalk_sfu" || *got.MediaPlaneSetting.Value != MediaPlaneProviderChalkSFU {
		t.Errorf("update = %+v", got)
	}

	if _, err := operator.SetSpace(context.Background(), tenantID, spaceID, nil); err != nil {
		t.Fatal(err)
	}
	if got := repository.updated; got.MediaPlaneSetting.Value != nil || *got.MediaPlane.Value != "cf_sfu" {
		t.Errorf("cleared update = %+v, want a null setting and the platform default in media_plane", got)
	}
}

func TestOperatorRefusesTheOwnSFUForTenantsThatCannotServeIt(t *testing.T) {
	tenantID, spaceID := ids(t)
	for name, config := range map[string]string{
		"tenant managed": `{"provider":"cf_sfu","mode":"tenant_managed"}`,
		"disabled":       `{"enabled":false,"mode":"chalk_managed"}`,
	} {
		repository := &updatingRepository{}
		operator := NewPlaneOperator(repository, tenantStore{tenant: tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(config)}}, PlanePolicy{Platform: MediaPlaneProviderCloudflareSFU})
		if _, err := operator.SetSpace(context.Background(), tenantID, spaceID, planePtr(MediaPlaneProviderChalkSFU)); !errors.Is(err, ErrTenantCannotServePlane) {
			t.Errorf("%s Space: got %v", name, err)
		}
		if _, err := operator.SetTenant(context.Background(), tenantID, planePtr(MediaPlaneProviderChalkSFU)); !errors.Is(err, ErrTenantCannotServePlane) {
			t.Errorf("%s Tenant: got %v", name, err)
		}
		if repository.calls != 0 {
			t.Errorf("%s: a refused write reached the repository", name)
		}
	}
}

type tenantStore struct {
	tenant tenants.Tenant
}

func (s tenantStore) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return s.tenant, nil
}

func (s tenantStore) SetDefaultMediaPlane(context.Context, utilities.ID, *string) (tenants.Tenant, error) {
	return s.tenant, nil
}

func TestLiveSwitchPausesOnTopOfTheDeployFloor(t *testing.T) {
	cf, own := MediaPlaneProviderCloudflareSFU, MediaPlaneProviderChalkSFU
	policy := PlanePolicy{Platform: own, Allowed: allowAll(t)}
	if got, _ := policy.Effective(tenants.Tenant{}, Space{}); got != own {
		t.Fatalf("an own SFU default with the switch on: got %q", got)
	}
	if got, _ := policy.Paused(true).Effective(tenants.Tenant{}, Space{}); got != cf {
		t.Fatalf("the live switch off must send new Episodes to Cloudflare: got %q", got)
	}
	floor := PlanePolicy{Platform: own, Allowed: allowAll(t), NewEpisodesPaused: true}
	if !floor.Paused(false).NewEpisodesPaused {
		t.Fatal("a live switch that is on must not lift the deploy-time floor")
	}
}

func TestPausedValueTravelsInTheContext(t *testing.T) {
	if _, carried := NewEpisodesPausedFrom(context.Background()); carried {
		t.Fatal("a plain context carries no switch value")
	}
	for _, want := range []bool{true, false} {
		got, carried := NewEpisodesPausedFrom(WithNewEpisodesPaused(context.Background(), want))
		if !carried || got != want {
			t.Fatalf("carried %v, got %v carried %v", want, got, carried)
		}
	}
}

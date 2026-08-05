package spaces_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCreateSpaceRejectsInvalidAdmissionPolicy(t *testing.T) {
	service := spaces.NewService(&spaceRepository{})
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")

	_, err := service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID:        tenantID,
		Name:            "Daily",
		Slug:            "daily",
		MediaPlane:      "cf_rtk",
		AdmissionPolicy: []byte(`{"mode":"unknown"}`),
	})
	if !errors.Is(err, spaces.ErrInvalidAdmissionPolicy) {
		t.Fatalf("error = %v, want invalid admission policy", err)
	}
}

func TestCreateSpaceAppliesSafeDurationDefaults(t *testing.T) {
	repository := &spaceRepository{}
	service := spaces.NewService(repository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")

	if _, err := service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID:   tenantID,
		Name:       "Daily",
		Slug:       "daily",
		MediaPlane: "cf_rtk",
	}); err != nil {
		t.Fatalf("create space: %v", err)
	}
	if repository.input.DefaultEpisodeDurationSeconds != spaces.DefaultEpisodeDurationSeconds ||
		repository.input.MaximumEpisodeDurationSeconds != spaces.DefaultMaximumEpisodeDurationSeconds ||
		repository.input.LingerWindowSeconds != spaces.DefaultLingerWindowSeconds {
		t.Fatalf("defaults = %d/%d/%d, want %d/%d/%d", repository.input.DefaultEpisodeDurationSeconds, repository.input.MaximumEpisodeDurationSeconds, repository.input.LingerWindowSeconds, spaces.DefaultEpisodeDurationSeconds, spaces.DefaultMaximumEpisodeDurationSeconds, spaces.DefaultLingerWindowSeconds)
	}
}

func TestUpdateSpaceRejectsDefaultAboveMaximum(t *testing.T) {
	service := spaces.NewService(&spaceRepository{})
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	spaceID := mustID(t, "22222222-2222-2222-2222-222222222222")
	defaultDuration := int32(7200)
	maximumDuration := int32(3600)

	_, err := service.UpdateSpace(context.Background(), tenantID, spaceID, spaces.UpdateSpaceInput{
		DefaultEpisodeDurationSeconds: spaces.OptionalInt32{Set: true, Value: &defaultDuration},
		MaximumEpisodeDurationSeconds: spaces.OptionalInt32{Set: true, Value: &maximumDuration},
	})
	if !errors.Is(err, spaces.ErrInvalidEpisodeCeiling) {
		t.Fatalf("error = %v, want invalid episode duration ceiling", err)
	}
}

type spaceRepository struct {
	input spaces.CreateSpaceInput
}

func (r *spaceRepository) CreateSpace(_ context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	r.input = input
	return spaces.Space{ID: input.ID, TenantID: input.TenantID}, nil
}

func (spaceRepository) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, errors.New("unexpected get space call")
}

func (spaceRepository) ListSpaces(context.Context, utilities.ID, pagination.PageRequest) (spaces.SpaceList, error) {
	return spaces.SpaceList{}, errors.New("unexpected list spaces call")
}

func (spaceRepository) UpdateSpace(context.Context, utilities.ID, utilities.ID, spaces.UpdateSpaceInput) (spaces.Space, error) {
	return spaces.Space{}, errors.New("unexpected update space call")
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

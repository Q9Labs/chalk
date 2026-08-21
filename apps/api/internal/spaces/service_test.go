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
	if repository.input.PublicInviteHandle == [32]byte{} {
		t.Fatal("create did not generate a public invite handle")
	}
}

func TestCreateSpaceUsesConfiguredDefaultMediaPlane(t *testing.T) {
	repository := &spaceRepository{}
	service := spaces.NewServiceWithDefaultProvider(repository, spaces.MediaPlaneProviderCloudflareSFU)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")

	if _, err := service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID: tenantID,
		Name:     "Daily",
		Slug:     "daily",
	}); err != nil {
		t.Fatalf("create space: %v", err)
	}
	if repository.input.MediaPlane != string(spaces.MediaPlaneProviderCloudflareSFU) {
		t.Fatalf("media plane = %q, want %q", repository.input.MediaPlane, spaces.MediaPlaneProviderCloudflareSFU)
	}
}

func TestCreateSpaceRejectsExplicitInvalidMediaPlaneValues(t *testing.T) {
	tests := []struct {
		name  string
		value string
	}{
		{name: "null", value: ""},
		{name: "empty", value: "   "},
		{name: "unknown", value: "mediasoup"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := spaces.NewServiceWithDefaultProvider(&spaceRepository{}, spaces.MediaPlaneProviderCloudflareSFU)
			tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")

			_, err := service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
				TenantID:      tenantID,
				Name:          "Daily",
				Slug:          "daily",
				MediaPlane:    test.value,
				MediaPlaneSet: true,
			})
			if !errors.Is(err, spaces.ErrInvalidMediaPlane) {
				t.Fatalf("error = %v, want invalid media plane", err)
			}
		})
	}
}

func TestCreateSpaceRejectsNonDashboardDeploymentDefault(t *testing.T) {
	service := spaces.NewServiceWithDefaultProvider(&spaceRepository{}, spaces.MediaPlaneProviderCloudflareRTK)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")

	_, err := service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID: tenantID,
		Name:     "Daily",
		Slug:     "daily",
	})
	if !errors.Is(err, spaces.ErrInvalidMediaPlane) {
		t.Fatalf("error = %v, want invalid deployment default", err)
	}
}

func TestCreateSpaceAppliesMediaPlaneDefaultBeforeFingerprint(t *testing.T) {
	firstRepository := &idempotentSpaceRepository{}
	firstService := spaces.NewServiceWithDefaultProvider(firstRepository, spaces.MediaPlaneProviderCloudflareSFU)
	secondRepository := &idempotentSpaceRepository{}
	secondService := spaces.NewService(secondRepository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	requestKey := "space-create-request-0001"

	if _, err := firstService.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Daily", Slug: "daily", RequestKey: requestKey,
	}); err != nil {
		t.Fatalf("defaulted create: %v", err)
	}
	if _, err := secondService.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Daily", Slug: "daily", MediaPlane: "cf_sfu", RequestKey: requestKey,
	}); err != nil {
		t.Fatalf("explicit create: %v", err)
	}
	if firstRepository.input.MediaPlane != secondRepository.input.MediaPlane || firstRepository.input.RequestFingerprint != secondRepository.input.RequestFingerprint {
		t.Fatalf("defaulted fingerprint/input = %q/%x, explicit = %q/%x", firstRepository.input.MediaPlane, firstRepository.input.RequestFingerprint, secondRepository.input.MediaPlane, secondRepository.input.RequestFingerprint)
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

func TestArchiveAndRestoreSpaceDelegateToRepository(t *testing.T) {
	repository := &archiveSpaceRepository{}
	service := spaces.NewService(repository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	spaceID := mustID(t, "22222222-2222-2222-2222-222222222222")

	archived, err := service.ArchiveSpace(context.Background(), tenantID, spaceID)
	if err != nil {
		t.Fatalf("archive space: %v", err)
	}
	if archived.ID != spaceID || !repository.archived {
		t.Fatalf("archive result = %#v, repository archived = %v", archived, repository.archived)
	}

	restored, err := service.RestoreSpace(context.Background(), tenantID, spaceID)
	if err != nil {
		t.Fatalf("restore space: %v", err)
	}
	if restored.ID != spaceID || repository.archived {
		t.Fatalf("restore result = %#v, repository archived = %v", restored, repository.archived)
	}
}

func TestListSpacesFilteredPreservesArchiveFilter(t *testing.T) {
	repository := &archiveSpaceRepository{}
	service := spaces.NewService(repository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	archived := true
	if _, err := service.ListSpacesFiltered(context.Background(), tenantID, pagination.PageRequest{}, &archived); err != nil {
		t.Fatalf("list filtered spaces: %v", err)
	}
	if repository.filter == nil || !*repository.filter {
		t.Fatalf("archive filter = %#v, want true", repository.filter)
	}
}

func TestCreateSpaceRequiresAValidRequestKeyForIdempotentCreates(t *testing.T) {
	repository := &idempotentSpaceRepository{}
	service := spaces.NewService(repository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")

	_, err := service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Daily", Slug: "daily", MediaPlane: "cf_rtk", RequestKey: "too-short",
	})
	if !errors.Is(err, spaces.ErrInvalidRequestKey) {
		t.Fatalf("invalid request key error = %v, want %v", err, spaces.ErrInvalidRequestKey)
	}

	_, err = service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Daily", Slug: "daily", MediaPlane: "cf_rtk", RequestKey: "space-create-request-0001",
	})
	if err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	if repository.calls != 1 || repository.input.RequestKey != "space-create-request-0001" || repository.input.RequestFingerprint == [32]byte{} || repository.input.PublicInviteHandle == [32]byte{} {
		t.Fatalf("idempotent input = %#v, calls = %d", repository.input, repository.calls)
	}
}

func TestCreateSpaceReturnsIdempotencyConflict(t *testing.T) {
	repository := &idempotentSpaceRepository{err: spaces.ErrIdempotencyConflict}
	service := spaces.NewService(repository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")

	_, err := service.CreateSpace(context.Background(), spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Daily", Slug: "daily", MediaPlane: "cf_rtk", RequestKey: "space-create-request-0001",
	})
	if !errors.Is(err, spaces.ErrIdempotencyConflict) {
		t.Fatalf("conflict error = %v, want %v", err, spaces.ErrIdempotencyConflict)
	}
}

func TestCreateSpaceFingerprintExcludesPublicInviteHandle(t *testing.T) {
	repository := &idempotentSpaceRepository{}
	service := spaces.NewService(repository)
	tenantID := mustID(t, "11111111-1111-1111-1111-111111111111")
	input := spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Daily", Slug: "daily", MediaPlane: "cf_rtk", RequestKey: "space-create-fingerprint-0001",
	}

	if _, err := service.CreateSpace(context.Background(), input); err != nil {
		t.Fatalf("first create: %v", err)
	}
	if _, err := service.CreateSpace(context.Background(), input); err != nil {
		t.Fatalf("replayed create: %v", err)
	}
	if len(repository.inputs) != 2 {
		t.Fatalf("captured inputs = %d, want 2", len(repository.inputs))
	}
	if repository.inputs[0].PublicInviteHandle == repository.inputs[1].PublicInviteHandle {
		t.Fatal("replayed create unexpectedly reused invite handle before persistence")
	}
	if repository.inputs[0].RequestFingerprint != repository.inputs[1].RequestFingerprint {
		t.Fatal("request fingerprint changed with generated invite handle")
	}
}

type spaceRepository struct {
	input spaces.CreateSpaceInput
}

type archiveSpaceRepository struct {
	archived bool
	filter   *bool
}

type idempotentSpaceRepository struct {
	spaceRepository
	input  spaces.CreateSpaceInput
	inputs []spaces.CreateSpaceInput
	calls  int
	err    error
}

func (r *idempotentSpaceRepository) CreateSpaceIdempotent(_ context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	r.calls++
	r.input = input
	r.inputs = append(r.inputs, input)
	if r.err != nil {
		return spaces.Space{}, r.err
	}
	return spaces.Space{ID: input.ID, TenantID: input.TenantID}, nil
}

func (r *archiveSpaceRepository) CreateSpace(context.Context, spaces.CreateSpaceInput) (spaces.Space, error) {
	return spaces.Space{}, nil
}

func (r *archiveSpaceRepository) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}

func (r *archiveSpaceRepository) ListSpaces(context.Context, utilities.ID, pagination.PageRequest) (spaces.SpaceList, error) {
	return spaces.SpaceList{}, nil
}

func (r *archiveSpaceRepository) ListSpacesFiltered(_ context.Context, _ utilities.ID, _ pagination.PageRequest, archived *bool) (spaces.SpaceList, error) {
	r.filter = archived
	return spaces.SpaceList{}, nil
}

func (r *archiveSpaceRepository) UpdateSpace(context.Context, utilities.ID, utilities.ID, spaces.UpdateSpaceInput) (spaces.Space, error) {
	return spaces.Space{}, nil
}

func (r *archiveSpaceRepository) ArchiveSpace(_ context.Context, _ utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	r.archived = true
	return spaces.Space{ID: spaceID}, nil
}

func (r *archiveSpaceRepository) RestoreSpace(_ context.Context, _ utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	r.archived = false
	return spaces.Space{ID: spaceID}, nil
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

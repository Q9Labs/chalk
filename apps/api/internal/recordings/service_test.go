package recordings_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestServiceCreateRejectsUnsupportedStorageProvider(t *testing.T) {
	service := recordings.NewService(recordingRepository{})

	_, err := service.Create(context.Background(), recordings.CreateInput{
		TenantID:        mustID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:          mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID:       mustID(t, "33333333-3333-4333-8333-333333333333"),
		Status:          recordings.StatusCompleted,
		StorageProvider: "s3",
	})
	if !errors.Is(err, recordings.ErrInvalidStorageProvider) {
		t.Fatalf("error = %v, want %v", err, recordings.ErrInvalidStorageProvider)
	}
}

func TestServiceCreateRejectsStorageKeyOutsideTenantPrefix(t *testing.T) {
	service := recordings.NewService(recordingRepository{})
	storageKey := "recordings/shared.webm"

	_, err := service.Create(context.Background(), recordings.CreateInput{
		TenantID:        mustID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:          mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID:       mustID(t, "33333333-3333-4333-8333-333333333333"),
		Status:          recordings.StatusCompleted,
		StorageProvider: recordings.StorageProviderR2,
		StorageKey:      &storageKey,
	})
	if !errors.Is(err, recordings.ErrInvalidStorageKey) {
		t.Fatalf("error = %v, want %v", err, recordings.ErrInvalidStorageKey)
	}
}

func TestServiceCreateRejectsUnusableStorageKey(t *testing.T) {
	service := recordings.NewService(recordingRepository{})
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")

	tests := []struct {
		name string
		key  string
	}{
		{name: "prefix only", key: recordings.TenantStorageKeyPrefix(tenantID)},
		{name: "relative segment", key: recordings.TenantStorageKeyPrefix(tenantID) + "../file.webm"},
		{name: "empty segment", key: recordings.TenantStorageKeyPrefix(tenantID) + "/file.webm"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.Create(context.Background(), recordings.CreateInput{
				TenantID:        tenantID,
				RoomID:          mustID(t, "22222222-2222-4222-8222-222222222222"),
				SessionID:       mustID(t, "33333333-3333-4333-8333-333333333333"),
				Status:          recordings.StatusCompleted,
				StorageProvider: recordings.StorageProviderR2,
				StorageKey:      &test.key,
			})
			if !errors.Is(err, recordings.ErrInvalidStorageKey) {
				t.Fatalf("error = %v, want %v", err, recordings.ErrInvalidStorageKey)
			}
		})
	}
}

func TestServiceUpdateRejectsUnsupportedStorageProvider(t *testing.T) {
	service := recordings.NewService(recordingRepository{})
	provider := "s3"

	_, err := service.Update(
		context.Background(),
		mustID(t, "11111111-1111-4111-8111-111111111111"),
		mustID(t, "44444444-4444-4444-8444-444444444444"),
		recordings.UpdateInput{
			StorageProvider: utilities.OptionalString{Set: true, Value: &provider},
		},
	)
	if !errors.Is(err, recordings.ErrInvalidStorageProvider) {
		t.Fatalf("error = %v, want %v", err, recordings.ErrInvalidStorageProvider)
	}
}

func TestServiceUpdateRejectsStorageKeyOutsideTenantPrefix(t *testing.T) {
	service := recordings.NewService(recordingRepository{})
	storageKey := "tenants/22222222-2222-4222-8222-222222222222/recordings/shared.webm"

	_, err := service.Update(
		context.Background(),
		mustID(t, "11111111-1111-4111-8111-111111111111"),
		mustID(t, "44444444-4444-4444-8444-444444444444"),
		recordings.UpdateInput{
			StorageKey: utilities.OptionalString{Set: true, Value: &storageKey},
		},
	)
	if !errors.Is(err, recordings.ErrInvalidStorageKey) {
		t.Fatalf("error = %v, want %v", err, recordings.ErrInvalidStorageKey)
	}
}

func TestServiceUpdateRejectsUnusableStorageKey(t *testing.T) {
	service := recordings.NewService(recordingRepository{})
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	storageKey := recordings.TenantStorageKeyPrefix(tenantID) + "../file.webm"

	_, err := service.Update(
		context.Background(),
		tenantID,
		mustID(t, "44444444-4444-4444-8444-444444444444"),
		recordings.UpdateInput{
			StorageKey: utilities.OptionalString{Set: true, Value: &storageKey},
		},
	)
	if !errors.Is(err, recordings.ErrInvalidStorageKey) {
		t.Fatalf("error = %v, want %v", err, recordings.ErrInvalidStorageKey)
	}
}

func TestTenantStorageKeyAcceptsTenantRecordingPrefix(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	storageKey := recordings.TenantStorageKeyPrefix(tenantID) + "room-session.webm"

	if !recordings.TenantStorageKey(tenantID, &storageKey) {
		t.Fatalf("tenant storage key %q was rejected", storageKey)
	}
}

type recordingRepository struct{}

func (recordingRepository) Create(context.Context, recordings.CreateInput) (recordings.Recording, error) {
	return recordings.Recording{}, errors.New("unexpected create")
}

func (recordingRepository) Get(context.Context, utilities.ID, utilities.ID) (recordings.Recording, error) {
	return recordings.Recording{}, errors.New("unexpected get")
}

func (recordingRepository) List(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (recordings.RecordingList, error) {
	return recordings.RecordingList{}, errors.New("unexpected list")
}

func (recordingRepository) Update(context.Context, utilities.ID, utilities.ID, recordings.UpdateInput) (recordings.Recording, error) {
	return recordings.Recording{}, errors.New("unexpected update")
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

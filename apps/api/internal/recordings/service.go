package recordings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjectkey"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidRecordingID      = errors.New("invalid recording id")
	ErrInvalidTenantID         = errors.New("invalid tenant id")
	ErrRecordingNotFound       = errors.New("recording not found")
	ErrRecordingDeleteConflict = errors.New("recording is still in progress or exporting")
	ErrRecordingDeleteActor    = errors.New("recording delete actor is required")
	ErrRecordingDeleteStorage  = errors.New("recording delete storage unavailable")
)

const (
	StatusPending    = "pending"
	StatusProcessing = "processing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
	StatusDeleted    = "deleted"

	StorageProviderR2 = "r2"
)

type Recording struct {
	ID                 utilities.ID
	TenantID           utilities.ID
	SpaceID            utilities.ID
	EpisodeID          utilities.ID
	Status             string
	StorageProvider    string
	StorageKey         *string
	StorageContentType *string
	StorageSize        *int64
	StorageChecksum    []byte
	Duration           time.Duration
	CompletedAt        *time.Time
	FailureCode        *string
	Metadata           json.RawMessage
	DeletedAt          *time.Time
	DeletedBy          *string
	UpdatedAt          time.Time
	CreatedAt          time.Time
}

type DeleteInput struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	DeletedBy   string
}

type DeleteObjectKeys func(ctx context.Context, keys []string) error

type ObjectDeleter interface {
	DeleteObject(context.Context, string) error
}

type Repository interface {
	Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (Recording, error)
	List(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) (RecordingList, error)
	Delete(ctx context.Context, input DeleteInput, deleteObjects DeleteObjectKeys) error
}

type Service struct {
	repository Repository
	objects    ObjectDeleter
}

type RecordingList struct {
	Recordings []Recording
	Page       pagination.Page
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) WithObjectDeleter(objects ObjectDeleter) Service {
	s.objects = objects
	return s
}

func (s Service) Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (Recording, error) {
	if tenantID.IsZero() {
		return Recording{}, ErrInvalidTenantID
	}
	if recordingID.IsZero() {
		return Recording{}, ErrInvalidRecordingID
	}

	return s.repository.Get(ctx, tenantID, recordingID)
}

func (s Service) List(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) (RecordingList, error) {
	if tenantID.IsZero() {
		return RecordingList{}, ErrInvalidTenantID
	}

	return s.repository.List(ctx, tenantID, spaceID, episodeID, page)
}

func (s Service) Delete(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, deletedBy string) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if recordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	if strings.TrimSpace(deletedBy) == "" {
		return ErrRecordingDeleteActor
	}
	if s.objects == nil {
		return ErrRecordingDeleteStorage
	}
	return s.repository.Delete(ctx, DeleteInput{TenantID: tenantID, RecordingID: recordingID, DeletedBy: deletedBy}, func(ctx context.Context, keys []string) error {
		for _, key := range keys {
			if err := s.objects.DeleteObject(ctx, key); err != nil && !errors.Is(err, objectstorage.ErrObjectNotFound) {
				return err
			}
		}
		return nil
	})
}

func TenantStorageKeyPrefix(tenantID utilities.ID) string {
	if tenantID.IsZero() {
		return ""
	}

	return recordingobjectkey.TenantRecordingsPrefix(tenantID.String())
}

func TenantStorageKey(tenantID utilities.ID, key *string) bool {
	if key == nil {
		return true
	}

	prefix := TenantStorageKeyPrefix(tenantID)
	if prefix == "" || !strings.HasPrefix(*key, prefix) {
		return false
	}

	return objectstorage.ValidateKey(*key) == nil && len(*key) > len(prefix)
}

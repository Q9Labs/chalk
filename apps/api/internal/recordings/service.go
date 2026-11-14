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
	ErrInvalidRecordingID = errors.New("invalid recording id")
	ErrInvalidTenantID    = errors.New("invalid tenant id")
	ErrRecordingNotFound  = errors.New("recording not found")
)

const (
	StatusPending    = "pending"
	StatusProcessing = "processing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"

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
	Metadata           json.RawMessage
	UpdatedAt          time.Time
	CreatedAt          time.Time
}

type Repository interface {
	Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (Recording, error)
	List(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) (RecordingList, error)
}

type Service struct {
	repository Repository
}

type RecordingList struct {
	Recordings []Recording
	Page       pagination.Page
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
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

package recordings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidRecordingID     = errors.New("invalid recording id")
	ErrInvalidTenantID        = errors.New("invalid tenant id")
	ErrInvalidRoomID          = errors.New("invalid room id")
	ErrInvalidSessionID       = errors.New("invalid session id")
	ErrInvalidRecordingStatus = errors.New("invalid recording status")
	ErrInvalidStorageProvider = errors.New("invalid storage provider")
	ErrInvalidStorageKey      = errors.New("invalid storage key")
	ErrInvalidRecordingField  = errors.New("invalid recording field")
	ErrSessionNotFound        = errors.New("room session not found")
	ErrRecordingNotFound      = errors.New("recording not found")
)

const (
	StatusPending    = "pending"
	StatusProcessing = "processing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"

	StorageProviderR2 = "r2"
)

type Recording struct {
	ID              utilities.ID
	TenantID        utilities.ID
	RoomID          utilities.ID
	SessionID       utilities.ID
	Status          string
	StorageProvider string
	StorageKey      *string
	Metadata        json.RawMessage
	UpdatedAt       time.Time
	CreatedAt       time.Time
}

type Repository interface {
	Create(ctx context.Context, input CreateInput) (Recording, error)
	Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (Recording, error)
	List(ctx context.Context, tenantID utilities.ID, sessionID utilities.ID, page pagination.PageRequest) (RecordingList, error)
	Update(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, input UpdateInput) (Recording, error)
}

type Service struct {
	repository Repository
}

type CreateInput struct {
	ID              utilities.ID
	TenantID        utilities.ID
	RoomID          utilities.ID
	SessionID       utilities.ID
	Status          string
	StorageProvider string
	StorageKey      *string
	Metadata        json.RawMessage
}

type UpdateInput struct {
	Status          utilities.OptionalString
	StorageProvider utilities.OptionalString
	StorageKey      utilities.OptionalString
	Metadata        utilities.OptionalJSON
}

type RecordingList struct {
	Recordings []Recording
	Page       pagination.Page
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) Create(ctx context.Context, input CreateInput) (Recording, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Recording{}, err
	}
	input.ID = id
	if err := prepareCreateRecordingInput(&input); err != nil {
		return Recording{}, err
	}

	return s.repository.Create(ctx, input)
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

func (s Service) List(ctx context.Context, tenantID utilities.ID, sessionID utilities.ID, page pagination.PageRequest) (RecordingList, error) {
	if tenantID.IsZero() {
		return RecordingList{}, ErrInvalidTenantID
	}

	return s.repository.List(ctx, tenantID, sessionID, page)
}

func (s Service) Update(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, input UpdateInput) (Recording, error) {
	if tenantID.IsZero() {
		return Recording{}, ErrInvalidTenantID
	}
	if recordingID.IsZero() {
		return Recording{}, ErrInvalidRecordingID
	}
	if err := prepareUpdateRecordingInput(tenantID, &input); err != nil {
		return Recording{}, err
	}

	return s.repository.Update(ctx, tenantID, recordingID, input)
}

func prepareCreateRecordingInput(input *CreateInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.RoomID.IsZero() {
		return ErrInvalidRoomID
	}
	if input.SessionID.IsZero() {
		return ErrInvalidSessionID
	}

	status, err := recordingStatus(input.Status)
	if err != nil {
		return err
	}
	input.Status = status

	storageProvider, err := storageProvider(input.StorageProvider)
	if err != nil {
		return ErrInvalidStorageProvider
	}
	input.StorageProvider = storageProvider

	input.StorageKey, err = utilities.NullableString(input.StorageKey)
	if err != nil {
		return ErrInvalidRecordingField
	}
	if !TenantStorageKey(input.TenantID, input.StorageKey) {
		return ErrInvalidStorageKey
	}
	input.Metadata, err = utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidRecordingField
	}

	return nil
}

func prepareUpdateRecordingInput(tenantID utilities.ID, input *UpdateInput) error {
	var err error

	input.Status, err = optionalStatus(input.Status)
	if err != nil {
		return err
	}
	input.StorageProvider, err = optionalStorageProvider(input.StorageProvider)
	if err != nil {
		return err
	}
	input.StorageKey, err = utilities.OptionalNullableString(input.StorageKey)
	if err != nil {
		return ErrInvalidRecordingField
	}
	if input.StorageKey.Set && !TenantStorageKey(tenantID, input.StorageKey.Value) {
		return ErrInvalidStorageKey
	}
	input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata)
	if err != nil {
		return ErrInvalidRecordingField
	}

	return nil
}

func optionalStatus(value utilities.OptionalString) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, ErrInvalidRecordingStatus
	}

	status, err := recordingStatus(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, err
	}

	return utilities.OptionalString{Set: true, Value: &status}, nil
}

func optionalStorageProvider(value utilities.OptionalString) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, ErrInvalidStorageProvider
	}

	provider, err := storageProvider(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, err
	}

	return utilities.OptionalString{Set: true, Value: &provider}, nil
}

func TenantStorageKeyPrefix(tenantID utilities.ID) string {
	if tenantID.IsZero() {
		return ""
	}

	return "tenants/" + tenantID.String() + "/recordings/"
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

func storageProvider(value string) (string, error) {
	provider, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidStorageProvider
	}
	switch provider {
	case StorageProviderR2:
		return provider, nil
	default:
		return "", ErrInvalidStorageProvider
	}
}

func recordingStatus(value string) (string, error) {
	status, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidRecordingStatus
	}
	switch status {
	case StatusPending, StatusProcessing, StatusCompleted, StatusFailed:
		return status, nil
	default:
		return "", ErrInvalidRecordingStatus
	}
}

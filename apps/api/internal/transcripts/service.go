package transcripts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTranscriptID     = errors.New("invalid transcript id")
	ErrInvalidTenantID         = errors.New("invalid tenant id")
	ErrInvalidRecordingID      = errors.New("invalid recording id")
	ErrInvalidRoomID           = errors.New("invalid room id")
	ErrInvalidSessionID        = errors.New("invalid session id")
	ErrInvalidTranscriptStatus = errors.New("invalid transcript status")
	ErrInvalidProvider         = errors.New("invalid transcript provider")
	ErrInvalidModel            = errors.New("invalid transcript model")
	ErrInvalidLanguages        = errors.New("invalid transcript languages")
	ErrInvalidTranscriptField  = errors.New("invalid transcript field")
	ErrRecordingNotFound       = errors.New("recording not found")
	ErrTranscriptNotFound      = errors.New("transcript not found")
)

const (
	StatusPending    = "pending"
	StatusProcessing = "processing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
)

type Transcript struct {
	ID          utilities.ID
	TenantID    utilities.ID
	RecordingID utilities.ID
	RoomID      utilities.ID
	SessionID   utilities.ID
	Status      string
	Provider    string
	Model       string
	Languages   []string
	Text        *string
	Metadata    json.RawMessage
	CompletedAt *time.Time
	UpdatedAt   time.Time
	CreatedAt   time.Time
}

type Repository interface {
	Create(ctx context.Context, input CreateInput) (Transcript, error)
	Get(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID) (Transcript, error)
	List(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, page pagination.PageRequest) (TranscriptList, error)
	Update(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID, input UpdateInput) (Transcript, error)
}

type Service struct {
	repository Repository
}

type CreateInput struct {
	ID          utilities.ID
	TenantID    utilities.ID
	RecordingID utilities.ID
	RoomID      utilities.ID
	SessionID   utilities.ID
	Status      string
	Provider    string
	Model       string
	Languages   []string
	Text        *string
	Metadata    json.RawMessage
	CompletedAt *time.Time
}

type UpdateInput struct {
	Status      utilities.OptionalString
	Provider    utilities.OptionalString
	Model       utilities.OptionalString
	Languages   OptionalStrings
	Text        utilities.OptionalString
	Metadata    utilities.OptionalJSON
	CompletedAt OptionalTime
}

type OptionalStrings struct {
	Set   bool
	Value []string
}

func (s *OptionalStrings) UnmarshalJSON(data []byte) error {
	s.Set = true

	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		s.Value = nil
		return nil
	}

	return json.Unmarshal(data, &s.Value)
}

type OptionalTime struct {
	Set   bool
	Value *time.Time
}

type TranscriptList struct {
	Transcripts []Transcript
	Page        pagination.Page
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) Create(ctx context.Context, input CreateInput) (Transcript, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Transcript{}, err
	}
	input.ID = id
	if err := prepareCreateInput(&input); err != nil {
		return Transcript{}, err
	}

	return s.repository.Create(ctx, input)
}

func (s Service) Get(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID) (Transcript, error) {
	if tenantID.IsZero() {
		return Transcript{}, ErrInvalidTenantID
	}
	if transcriptID.IsZero() {
		return Transcript{}, ErrInvalidTranscriptID
	}

	return s.repository.Get(ctx, tenantID, transcriptID)
}

func (s Service) List(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, page pagination.PageRequest) (TranscriptList, error) {
	if tenantID.IsZero() {
		return TranscriptList{}, ErrInvalidTenantID
	}

	return s.repository.List(ctx, tenantID, recordingID, page)
}

func (s Service) Update(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID, input UpdateInput) (Transcript, error) {
	if tenantID.IsZero() {
		return Transcript{}, ErrInvalidTenantID
	}
	if transcriptID.IsZero() {
		return Transcript{}, ErrInvalidTranscriptID
	}
	if err := prepareUpdateInput(&input); err != nil {
		return Transcript{}, err
	}

	return s.repository.Update(ctx, tenantID, transcriptID, input)
}

func prepareCreateInput(input *CreateInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.RecordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	if input.RoomID.IsZero() {
		return ErrInvalidRoomID
	}
	if input.SessionID.IsZero() {
		return ErrInvalidSessionID
	}

	status, err := transcriptStatus(input.Status)
	if err != nil {
		return err
	}
	input.Status = status

	provider, err := utilities.RequiredString(input.Provider)
	if err != nil {
		return ErrInvalidProvider
	}
	input.Provider = provider

	model, err := utilities.RequiredString(input.Model)
	if err != nil {
		return ErrInvalidModel
	}
	input.Model = model

	languages, err := languageList(input.Languages)
	if err != nil {
		return err
	}
	input.Languages = languages

	input.Text, err = utilities.NullableString(input.Text)
	if err != nil {
		return ErrInvalidTranscriptField
	}
	input.Metadata, err = utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidTranscriptField
	}

	return nil
}

func prepareUpdateInput(input *UpdateInput) error {
	var err error

	input.Status, err = optionalStatus(input.Status)
	if err != nil {
		return err
	}
	input.Provider, err = requiredOptionalString(input.Provider, ErrInvalidProvider)
	if err != nil {
		return err
	}
	input.Model, err = requiredOptionalString(input.Model, ErrInvalidModel)
	if err != nil {
		return err
	}
	if input.Languages.Set {
		if input.Languages.Value == nil {
			return ErrInvalidLanguages
		}
		input.Languages.Value, err = languageList(input.Languages.Value)
		if err != nil {
			return err
		}
	}
	input.Text, err = utilities.OptionalNullableString(input.Text)
	if err != nil {
		return ErrInvalidTranscriptField
	}
	input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata)
	if err != nil {
		return ErrInvalidTranscriptField
	}

	return nil
}

func languageList(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, ErrInvalidLanguages
	}

	languages := make([]string, 0, len(values))
	for _, value := range values {
		language, err := utilities.RequiredString(value)
		if err != nil {
			return nil, ErrInvalidLanguages
		}
		languages = append(languages, language)
	}

	return languages, nil
}

func requiredOptionalString(value utilities.OptionalString, invalid error) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, invalid
	}

	prepared, err := utilities.RequiredString(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, invalid
	}

	return utilities.OptionalString{Set: true, Value: &prepared}, nil
}

func optionalStatus(value utilities.OptionalString) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, ErrInvalidTranscriptStatus
	}

	status, err := transcriptStatus(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, err
	}

	return utilities.OptionalString{Set: true, Value: &status}, nil
}

func transcriptStatus(value string) (string, error) {
	status, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidTranscriptStatus
	}
	switch status {
	case StatusPending, StatusProcessing, StatusCompleted, StatusFailed:
		return status, nil
	default:
		return "", ErrInvalidTranscriptStatus
	}
}

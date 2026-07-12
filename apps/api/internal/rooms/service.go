package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidRoomID        = errors.New("invalid room id")
	ErrInvalidSessionID     = errors.New("invalid session id")
	ErrInvalidTenantID      = errors.New("invalid tenant id")
	ErrInvalidRoomName      = errors.New("invalid room name")
	ErrInvalidRoomSlug      = errors.New("invalid room slug")
	ErrInvalidRoomStatus    = errors.New("invalid room status")
	ErrInvalidMediaPlane    = errors.New("invalid media plane")
	ErrInvalidSessionStatus = errors.New("invalid session status")
	ErrInvalidRoomField     = errors.New("invalid room field")
	ErrRoomNotFound         = errors.New("room not found")
	ErrRoomSlugAlreadyUsed  = errors.New("room slug already used")
	ErrSessionNotFound      = errors.New("room session not found")
)

const (
	StatusActive   = "active"
	StatusArchived = "archived"
	StatusEnded    = "ended"

	SessionStatusPending = "pending"
	SessionStatusActive  = "active"
	SessionStatusEnded   = "ended"
	SessionStatusFailed  = "failed"
)

type Room struct {
	ID              utilities.ID
	Name            string
	TenantID        utilities.ID
	Status          string
	Slug            string
	MediaPlane      string
	Metadata        json.RawMessage
	RecurringPolicy json.RawMessage
	CreatedByUserID utilities.ID
	UpdatedAt       time.Time
	CreatedAt       time.Time
}

type Session struct {
	ID              utilities.ID
	Status          string
	Metadata        json.RawMessage
	RoomID          utilities.ID
	TenantID        utilities.ID
	CreatedByUserID utilities.ID
	StartedAt       *time.Time
	EndedAt         *time.Time
	UpdatedAt       time.Time
	CreatedAt       time.Time
}

type Repository interface {
	CreateRoom(ctx context.Context, input CreateRoomInput) (Room, error)
	GetRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID) (Room, error)
	ListRooms(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (RoomList, error)
	UpdateRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, input UpdateRoomInput) (Room, error)
	CreateSession(ctx context.Context, input CreateSessionInput) (Session, error)
	GetSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (Session, error)
	ListSessions(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, page pagination.PageRequest) (SessionList, error)
	UpdateSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, input UpdateSessionInput) (Session, error)
}

type Service struct {
	repository Repository
}

type CreateRoomInput struct {
	ID              utilities.ID
	Name            string
	TenantID        utilities.ID
	Status          string
	Slug            string
	MediaPlane      string
	Metadata        json.RawMessage
	RecurringPolicy json.RawMessage
	CreatedByUserID utilities.ID
}

type UpdateRoomInput struct {
	Name            utilities.OptionalString
	Status          utilities.OptionalString
	Slug            utilities.OptionalString
	MediaPlane      utilities.OptionalString
	Metadata        utilities.OptionalJSON
	RecurringPolicy utilities.OptionalJSON
}

type CreateSessionInput struct {
	ID              utilities.ID
	Status          string
	Metadata        json.RawMessage
	RoomID          utilities.ID
	TenantID        utilities.ID
	CreatedByUserID utilities.ID
	StartedAt       *time.Time
	EndedAt         *time.Time
}

type UpdateSessionInput struct {
	Status    utilities.OptionalString
	Metadata  utilities.OptionalJSON
	StartedAt OptionalTime
	EndedAt   OptionalTime
}

type OptionalTime struct {
	Set   bool
	Value *time.Time
}

type RoomList struct {
	Rooms []Room
	Page  pagination.Page
}

type SessionList struct {
	Sessions []Session
	Page     pagination.Page
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) CreateRoom(ctx context.Context, input CreateRoomInput) (Room, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Room{}, err
	}
	input.ID = id
	if err := prepareCreateRoomInput(&input); err != nil {
		return Room{}, err
	}

	return s.repository.CreateRoom(ctx, input)
}

func (s Service) GetRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID) (Room, error) {
	if err := validateTenantRoomIDs(tenantID, roomID); err != nil {
		return Room{}, err
	}

	return s.repository.GetRoom(ctx, tenantID, roomID)
}

func (s Service) ListRooms(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (RoomList, error) {
	if tenantID.IsZero() {
		return RoomList{}, ErrInvalidTenantID
	}

	return s.repository.ListRooms(ctx, tenantID, page)
}

func (s Service) UpdateRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, input UpdateRoomInput) (Room, error) {
	if err := validateTenantRoomIDs(tenantID, roomID); err != nil {
		return Room{}, err
	}
	if err := prepareUpdateRoomInput(&input); err != nil {
		return Room{}, err
	}

	return s.repository.UpdateRoom(ctx, tenantID, roomID, input)
}

func (s Service) CreateSession(ctx context.Context, input CreateSessionInput) (Session, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Session{}, err
	}
	input.ID = id
	if err := prepareCreateSessionInput(&input); err != nil {
		return Session{}, err
	}

	return s.repository.CreateSession(ctx, input)
}

func (s Service) GetSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (Session, error) {
	if err := validateTenantRoomSessionIDs(tenantID, roomID, sessionID); err != nil {
		return Session{}, err
	}

	return s.repository.GetSession(ctx, tenantID, roomID, sessionID)
}

func (s Service) ListSessions(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, page pagination.PageRequest) (SessionList, error) {
	if err := validateTenantRoomIDs(tenantID, roomID); err != nil {
		return SessionList{}, err
	}

	return s.repository.ListSessions(ctx, tenantID, roomID, page)
}

func (s Service) UpdateSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, input UpdateSessionInput) (Session, error) {
	if err := validateTenantRoomSessionIDs(tenantID, roomID, sessionID); err != nil {
		return Session{}, err
	}
	if err := prepareUpdateSessionInput(&input); err != nil {
		return Session{}, err
	}

	return s.repository.UpdateSession(ctx, tenantID, roomID, sessionID, input)
}

func prepareCreateRoomInput(input *CreateRoomInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}

	name, err := utilities.RequiredString(input.Name)
	if err != nil {
		return ErrInvalidRoomName
	}
	input.Name = name

	status, err := roomStatus(input.Status)
	if err != nil {
		return err
	}
	input.Status = status

	slug, err := utilities.RequiredString(input.Slug)
	if err != nil {
		return ErrInvalidRoomSlug
	}
	input.Slug = slug

	mediaPlane, err := utilities.RequiredString(input.MediaPlane)
	if err != nil {
		return ErrInvalidMediaPlane
	}
	input.MediaPlane = mediaPlane

	input.Metadata, err = utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidRoomField
	}
	input.RecurringPolicy, err = utilities.JSON(input.RecurringPolicy)
	if err != nil {
		return ErrInvalidRoomField
	}

	return nil
}

func prepareUpdateRoomInput(input *UpdateRoomInput) error {
	var err error

	input.Name, err = requiredOptionalString(input.Name, ErrInvalidRoomName)
	if err != nil {
		return err
	}
	input.Status, err = optionalStatus(input.Status, roomStatus, ErrInvalidRoomStatus)
	if err != nil {
		return err
	}
	input.Slug, err = requiredOptionalString(input.Slug, ErrInvalidRoomSlug)
	if err != nil {
		return err
	}
	input.MediaPlane, err = requiredOptionalString(input.MediaPlane, ErrInvalidMediaPlane)
	if err != nil {
		return err
	}
	input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata)
	if err != nil {
		return ErrInvalidRoomField
	}
	input.RecurringPolicy, err = utilities.OptionalNullableJSON(input.RecurringPolicy)
	if err != nil {
		return ErrInvalidRoomField
	}

	return nil
}

func prepareCreateSessionInput(input *CreateSessionInput) error {
	if err := validateTenantRoomIDs(input.TenantID, input.RoomID); err != nil {
		return err
	}

	status, err := sessionStatus(input.Status)
	if err != nil {
		return err
	}
	input.Status = status

	input.Metadata, err = utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidRoomField
	}

	return nil
}

func prepareUpdateSessionInput(input *UpdateSessionInput) error {
	var err error

	if input.Status.Set || input.EndedAt.Set {
		return ErrInvalidSessionStatus
	}
	input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata)
	if err != nil {
		return ErrInvalidRoomField
	}

	return nil
}

func validateTenantRoomIDs(tenantID utilities.ID, roomID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if roomID.IsZero() {
		return ErrInvalidRoomID
	}
	return nil
}

func validateTenantRoomSessionIDs(tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) error {
	if err := validateTenantRoomIDs(tenantID, roomID); err != nil {
		return err
	}
	if sessionID.IsZero() {
		return ErrInvalidSessionID
	}
	return nil
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

func optionalStatus(value utilities.OptionalString, validate func(string) (string, error), invalid error) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, invalid
	}

	status, err := validate(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, err
	}

	return utilities.OptionalString{Set: true, Value: &status}, nil
}

func roomStatus(value string) (string, error) {
	status, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidRoomStatus
	}
	switch status {
	case StatusActive, StatusArchived, StatusEnded:
		return status, nil
	default:
		return "", ErrInvalidRoomStatus
	}
}

func sessionStatus(value string) (string, error) {
	status, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidSessionStatus
	}
	switch status {
	case SessionStatusPending, SessionStatusActive, SessionStatusEnded, SessionStatusFailed:
		return status, nil
	default:
		return "", ErrInvalidSessionStatus
	}
}

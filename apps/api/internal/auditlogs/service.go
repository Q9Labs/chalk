package auditlogs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidAuditLogID = errors.New("invalid audit log id")
	ErrInvalidTenantID   = errors.New("invalid tenant id")
	ErrInvalidActorType  = errors.New("invalid audit actor type")
	ErrInvalidAction     = errors.New("invalid audit action")
	ErrInvalidOutcome    = errors.New("invalid audit outcome")
	ErrInvalidField      = errors.New("invalid audit field")
	ErrAuditLogNotFound  = errors.New("audit log not found")
)

const (
	ActorUser   = "user"
	ActorAPIKey = "api_key"
	ActorSystem = "system"

	OutcomeSuccess = "success"
	OutcomeFailure = "failure"
	OutcomePending = "pending"
)

type AuditLog struct {
	ID           utilities.ID
	TenantID     utilities.ID
	ActorUserID  utilities.ID
	ActorType    string
	Action       string
	ResourceType *string
	ResourceID   utilities.ID
	Details      json.RawMessage
	Outcome      string
	ErrorCode    *string
	ErrorMessage *string
	Before       json.RawMessage
	After        json.RawMessage
	UpdatedAt    time.Time
	CreatedAt    time.Time
}

type Repository interface {
	Create(ctx context.Context, input CreateInput) (AuditLog, error)
	Get(ctx context.Context, tenantID utilities.ID, auditLogID utilities.ID) (AuditLog, error)
	List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (AuditLogList, error)
}

type Service struct {
	repository Repository
}

type CreateInput struct {
	ID           utilities.ID
	TenantID     utilities.ID
	ActorUserID  utilities.ID
	ActorType    string
	Action       string
	ResourceType *string
	ResourceID   utilities.ID
	Details      json.RawMessage
	Outcome      string
	ErrorCode    *string
	ErrorMessage *string
	Before       json.RawMessage
	After        json.RawMessage
}

type AuditLogList struct {
	AuditLogs []AuditLog
	Page      pagination.Page
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) Create(ctx context.Context, input CreateInput) (AuditLog, error) {
	id, err := utilities.NewID()
	if err != nil {
		return AuditLog{}, err
	}
	input.ID = id
	if err := prepareCreateInput(&input); err != nil {
		return AuditLog{}, err
	}

	return s.repository.Create(ctx, input)
}

func (s Service) Get(ctx context.Context, tenantID utilities.ID, auditLogID utilities.ID) (AuditLog, error) {
	if tenantID.IsZero() {
		return AuditLog{}, ErrInvalidTenantID
	}
	if auditLogID.IsZero() {
		return AuditLog{}, ErrInvalidAuditLogID
	}

	return s.repository.Get(ctx, tenantID, auditLogID)
}

func (s Service) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (AuditLogList, error) {
	if tenantID.IsZero() {
		return AuditLogList{}, ErrInvalidTenantID
	}

	return s.repository.List(ctx, tenantID, page)
}

func PrincipalActor(principal authentication.Principal) (string, utilities.ID) {
	switch principal.Kind {
	case authentication.PrincipalUser:
		return ActorUser, principal.UserID
	case authentication.PrincipalAPIKey:
		return ActorAPIKey, utilities.ID{}
	case authentication.PrincipalSystem:
		return ActorSystem, utilities.ID{}
	default:
		return ActorSystem, utilities.ID{}
	}
}

func prepareCreateInput(input *CreateInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}

	actorType, err := actorType(input.ActorType)
	if err != nil {
		return err
	}
	input.ActorType = actorType

	action, err := utilities.RequiredString(input.Action)
	if err != nil {
		return ErrInvalidAction
	}
	input.Action = action
	input.ResourceType, err = utilities.NullableString(input.ResourceType)
	if err != nil {
		return ErrInvalidField
	}

	outcome, err := outcome(input.Outcome)
	if err != nil {
		return err
	}
	input.Outcome = outcome

	input.Details, err = utilities.JSON(input.Details)
	if err != nil {
		return ErrInvalidField
	}
	input.Before, err = utilities.JSON(input.Before)
	if err != nil {
		return ErrInvalidField
	}
	input.After, err = utilities.JSON(input.After)
	if err != nil {
		return ErrInvalidField
	}
	input.ErrorCode, err = utilities.NullableString(input.ErrorCode)
	if err != nil {
		return ErrInvalidField
	}
	input.ErrorMessage, err = utilities.NullableString(input.ErrorMessage)
	if err != nil {
		return ErrInvalidField
	}

	return nil
}

func actorType(value string) (string, error) {
	actor, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidActorType
	}
	switch actor {
	case ActorUser, ActorAPIKey, ActorSystem:
		return actor, nil
	default:
		return "", ErrInvalidActorType
	}
}

func outcome(value string) (string, error) {
	result, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidOutcome
	}
	switch result {
	case OutcomeSuccess, OutcomeFailure, OutcomePending:
		return result, nil
	default:
		return "", ErrInvalidOutcome
	}
}

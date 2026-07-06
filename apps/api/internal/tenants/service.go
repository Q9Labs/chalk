package tenants

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTenantID     = errors.New("invalid tenant id")
	ErrInvalidTenantName   = errors.New("invalid tenant name")
	ErrInvalidTenantRegion = errors.New("invalid tenant region")
	ErrInvalidTenantField  = errors.New("invalid tenant field")
	ErrTenantNotFound      = errors.New("tenant not found")
)

type Tenant struct {
	ID                       utilities.ID
	Name                     string
	DefaultRegion            *string
	DefaultMediaPlane        *string
	MediaPlaneProviderConfig json.RawMessage
	AIProviderConfig         json.RawMessage
	StorageProviderConfig    json.RawMessage
	LogoKey                  *string
	Website                  *string
	UpdatedAt                time.Time
	CreatedAt                time.Time
}

type TenantRepository interface {
	CreateTenant(ctx context.Context, input CreateTenantInput) (Tenant, error)
	GetTenant(ctx context.Context, id utilities.ID) (Tenant, error)
	ListTenants(ctx context.Context, page pagination.PageRequest) (TenantList, error)
	UpdateTenant(ctx context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error)
}

type Service struct {
	repository TenantRepository
}

type CreateTenantInput struct {
	ID                       utilities.ID
	Name                     string
	DefaultRegion            *string
	DefaultMediaPlane        *string
	MediaPlaneProviderConfig json.RawMessage
	AIProviderConfig         json.RawMessage
	StorageProviderConfig    json.RawMessage
	LogoKey                  *string
	Website                  *string
}

type UpdateTenantInput struct {
	Name                     utilities.OptionalString
	DefaultRegion            utilities.OptionalString
	DefaultMediaPlane        utilities.OptionalString
	MediaPlaneProviderConfig utilities.OptionalJSON
	AIProviderConfig         utilities.OptionalJSON
	StorageProviderConfig    utilities.OptionalJSON
	LogoKey                  utilities.OptionalString
	Website                  utilities.OptionalString
}

type TenantList struct {
	Tenants []Tenant
	Page    pagination.Page
}

func NewService(repository TenantRepository) Service {
	return Service{repository: repository}
}

func (s Service) CreateTenant(ctx context.Context, input CreateTenantInput) (Tenant, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Tenant{}, err
	}

	input.ID = id
	if err := prepareCreateTenantInput(&input); err != nil {
		return Tenant{}, err
	}

	return s.repository.CreateTenant(ctx, input)
}

func (s Service) GetTenant(ctx context.Context, id utilities.ID) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}

	return s.repository.GetTenant(ctx, id)
}

func (s Service) ListTenants(ctx context.Context, page pagination.PageRequest) (TenantList, error) {
	return s.repository.ListTenants(ctx, page)
}

func (s Service) UpdateTenant(ctx context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}
	if err := prepareUpdateTenantInput(&input); err != nil {
		return Tenant{}, err
	}

	return s.repository.UpdateTenant(ctx, id, input)
}

func (Service) AvailableRegions(ctx context.Context) ([]regions.Region, error) {
	return regions.Available(), nil
}

func prepareCreateTenantInput(input *CreateTenantInput) error {
	name, err := utilities.RequiredString(input.Name)
	if err != nil {
		return ErrInvalidTenantName
	}
	input.Name = name

	defaultRegion, err := utilities.NullableString(input.DefaultRegion)
	if err != nil {
		return ErrInvalidTenantRegion
	}
	if defaultRegion != nil && !regions.Contains(*defaultRegion) {
		return ErrInvalidTenantRegion
	}
	input.DefaultRegion = defaultRegion

	if err := prepareCreateNullableFields(input); err != nil {
		return err
	}

	return nil
}

func prepareCreateNullableFields(input *CreateTenantInput) error {
	var err error

	input.DefaultMediaPlane, err = utilities.NullableString(input.DefaultMediaPlane)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.MediaPlaneProviderConfig, err = utilities.JSON(input.MediaPlaneProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.AIProviderConfig, err = utilities.JSON(input.AIProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.StorageProviderConfig, err = utilities.JSON(input.StorageProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.LogoKey, err = utilities.NullableString(input.LogoKey)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.Website, err = utilities.NullableString(input.Website)
	if err != nil {
		return ErrInvalidTenantField
	}

	return nil
}

func prepareUpdateTenantInput(input *UpdateTenantInput) error {
	if input.Name.Set {
		if input.Name.Value == nil {
			return ErrInvalidTenantName
		}

		name, err := utilities.RequiredString(*input.Name.Value)
		if err != nil {
			return ErrInvalidTenantName
		}
		input.Name.Value = &name
	}

	defaultRegion, err := utilities.OptionalNullableString(input.DefaultRegion)
	if err != nil {
		return ErrInvalidTenantRegion
	}
	if defaultRegion.Set && defaultRegion.Value != nil && !regions.Contains(*defaultRegion.Value) {
		return ErrInvalidTenantRegion
	}
	input.DefaultRegion = defaultRegion

	if err := prepareUpdateNullableFields(input); err != nil {
		return err
	}

	return nil
}

func prepareUpdateNullableFields(input *UpdateTenantInput) error {
	var err error

	input.DefaultMediaPlane, err = utilities.OptionalNullableString(input.DefaultMediaPlane)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.MediaPlaneProviderConfig, err = utilities.OptionalNullableJSON(input.MediaPlaneProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.AIProviderConfig, err = utilities.OptionalNullableJSON(input.AIProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.StorageProviderConfig, err = utilities.OptionalNullableJSON(input.StorageProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.LogoKey, err = utilities.OptionalNullableString(input.LogoKey)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.Website, err = utilities.OptionalNullableString(input.Website)
	if err != nil {
		return ErrInvalidTenantField
	}

	return nil
}

package tenants

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTenantID   = errors.New("invalid tenant id")
	ErrInvalidTenantName = errors.New("invalid tenant name")

	ErrInvalidTenantField    = errors.New("invalid tenant field")
	ErrInvalidCORSOrigin     = errors.New("invalid tenant CORS origin")
	ErrTenantNotFound        = errors.New("tenant not found")
	ErrInvalidAccountID      = errors.New("invalid dashboard account id")
	ErrInvalidRequestKey     = errors.New("invalid tenant onboarding request key")
	ErrIdempotencyConflict   = errors.New("tenant onboarding idempotency conflict")
	ErrInvalidArtifactPolicy = errors.New("invalid Tenant Artifact policy")
)

type Tenant struct {
	ID                 utilities.ID
	Name               string
	CreatedByServiceID *string
	ExternalID         *string

	DefaultMediaPlane        *string
	MediaPlaneProviderConfig json.RawMessage
	StorageProviderConfig    json.RawMessage
	CORSAllowedOrigins       []string
	LogoKey                  *string
	Website                  *string
	ArtifactPolicy           artifactpolicy.TenantPolicy
	UpdatedAt                time.Time
	CreatedAt                time.Time
}

type TenantRepository interface {
	CreateTenant(ctx context.Context, input CreateTenantInput) (Tenant, error)
	GetTenant(ctx context.Context, id utilities.ID) (Tenant, error)
	ListTenants(ctx context.Context, page pagination.PageRequest) (TenantList, error)
	UpdateTenant(ctx context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error)
	GetTenantCORSAllowedOrigins(ctx context.Context, id utilities.ID) ([]string, error)
	ListServiceTenants(context.Context, string, pagination.PageRequest) (TenantList, error)
	FindServiceTenant(context.Context, string, string) (Tenant, error)
}

type Service struct {
	repository TenantRepository
}

type CreateTenantInput struct {
	ID                 utilities.ID
	Name               string
	CreatedByServiceID *string
	ExternalID         *string

	DefaultMediaPlane        *string
	MediaPlaneProviderConfig json.RawMessage
	StorageProviderConfig    json.RawMessage
	CORSAllowedOrigins       []string
	LogoKey                  *string
	Website                  *string
}

type UpdateTenantInput struct {
	Name utilities.OptionalString

	DefaultMediaPlane        utilities.OptionalString
	MediaPlaneProviderConfig utilities.OptionalJSON
	StorageProviderConfig    utilities.OptionalJSON
	CORSAllowedOrigins       OptionalCORSOrigins
	LogoKey                  utilities.OptionalString
	Website                  utilities.OptionalString
	ArtifactPolicy           ArtifactPolicyUpdate
}

type ArtifactPolicyUpdate struct {
	TranscriptionCeiling             utilities.OptionalString
	TranscriptionDefaultMode         utilities.OptionalString
	ProviderPolicyVersion            utilities.OptionalString
	RecordingRetentionSeconds        OptionalInt64
	TranscriptRetentionSeconds       OptionalInt64
	TranscriptionSourceWindowSeconds OptionalInt64
}

type OptionalInt64 struct {
	Set   bool
	Value *int64
}

func (value *OptionalInt64) UnmarshalJSON(data []byte) error {
	value.Set = true
	if strings.TrimSpace(string(data)) == "null" {
		value.Value = nil
		return nil
	}

	var number int64
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	value.Value = &number
	return nil
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
	if input.CreatedByServiceID != nil && !ValidServiceID(*input.CreatedByServiceID) {
		return Tenant{}, ErrInvalidTenantField
	}
	if input.ExternalID != nil && (input.CreatedByServiceID == nil || !ValidExternalID(*input.ExternalID)) {
		return Tenant{}, ErrInvalidTenantField
	}
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

func (s Service) AllowsOrigin(ctx context.Context, id utilities.ID, origin string) (bool, error) {
	if id.IsZero() {
		return false, ErrInvalidTenantID
	}
	prepared, err := CORSOrigin(origin)
	if err != nil {
		return false, nil
	}
	origins, err := s.repository.GetTenantCORSAllowedOrigins(ctx, id)
	if errors.Is(err, ErrTenantNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, allowed := range origins {
		if allowed == prepared {
			return true, nil
		}
	}
	return false, nil
}

func prepareCreateTenantInput(input *CreateTenantInput) error {
	name, err := utilities.RequiredString(input.Name)
	if err != nil {
		return ErrInvalidTenantName
	}
	input.Name = name

	input.CORSAllowedOrigins, err = CORSOrigins(input.CORSAllowedOrigins)
	if err != nil {
		return err
	}

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

	if input.CORSAllowedOrigins.Set {
		origins, originsErr := CORSOrigins(input.CORSAllowedOrigins.Value)
		if originsErr != nil {
			return originsErr
		}
		input.CORSAllowedOrigins.Value = origins
	}

	if err := prepareUpdateNullableFields(input); err != nil {
		return err
	}
	if err := prepareArtifactPolicyUpdate(&input.ArtifactPolicy); err != nil {
		return err
	}

	return nil
}

func prepareArtifactPolicyUpdate(input *ArtifactPolicyUpdate) error {
	if input.TranscriptionCeiling.Set {
		if input.TranscriptionCeiling.Value == nil {
			return ErrInvalidArtifactPolicy
		}
		mode := artifactpolicy.TranscriptionMode(strings.TrimSpace(*input.TranscriptionCeiling.Value))
		if err := mode.Validate(); err != nil {
			return err
		}
		value := string(mode)
		input.TranscriptionCeiling.Value = &value
	}
	if input.TranscriptionDefaultMode.Set {
		if input.TranscriptionDefaultMode.Value == nil {
			return ErrInvalidArtifactPolicy
		}
		mode := artifactpolicy.TranscriptionMode(strings.TrimSpace(*input.TranscriptionDefaultMode.Value))
		if err := mode.Validate(); err != nil {
			return err
		}
		value := string(mode)
		input.TranscriptionDefaultMode.Value = &value
	}
	if input.ProviderPolicyVersion.Set {
		if input.ProviderPolicyVersion.Value == nil {
			return artifactpolicy.ErrMissingProviderPolicy
		}
		value, err := utilities.RequiredString(*input.ProviderPolicyVersion.Value)
		if err != nil {
			return artifactpolicy.ErrMissingProviderPolicy
		}
		input.ProviderPolicyVersion.Value = &value
	}
	if err := validateOptionalSeconds(input.RecordingRetentionSeconds); err != nil {
		return artifactpolicy.ErrInvalidRetention
	}
	if err := validateOptionalSeconds(input.TranscriptRetentionSeconds); err != nil {
		return artifactpolicy.ErrInvalidRetention
	}
	if !input.TranscriptionSourceWindowSeconds.Set || input.TranscriptionSourceWindowSeconds.Value == nil {
		if input.TranscriptionSourceWindowSeconds.Set {
			return artifactpolicy.ErrInvalidSourceWindow
		}
	} else if *input.TranscriptionSourceWindowSeconds.Value < 0 || *input.TranscriptionSourceWindowSeconds.Value > int64(artifactpolicy.MaximumSourceWindow/time.Second) {
		return artifactpolicy.ErrInvalidSourceWindow
	}
	return nil
}

func validateOptionalSeconds(value OptionalInt64) error {
	if value.Set && (value.Value == nil ||
		*value.Value < 0 ||
		*value.Value > artifactpolicy.MaximumRetentionSeconds) {
		return artifactpolicy.ErrInvalidRetention
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

func ValidServiceID(id string) bool {
	return len(id) > 0 && len(id) <= 128 && strings.TrimSpace(id) == id
}
func ValidExternalID(id string) bool {
	return len(id) > 0 && len(id) <= 512 && strings.TrimSpace(id) == id
}

func (s Service) ListServiceTenants(ctx context.Context, serviceID string, page pagination.PageRequest) (TenantList, error) {
	if !ValidServiceID(serviceID) {
		return TenantList{}, ErrInvalidTenantField
	}
	return s.repository.ListServiceTenants(ctx, serviceID, page)
}

func (s Service) FindServiceTenant(ctx context.Context, serviceID, externalID string) (Tenant, error) {
	if !ValidServiceID(serviceID) || !ValidExternalID(externalID) {
		return Tenant{}, ErrInvalidTenantField
	}
	return s.repository.FindServiceTenant(ctx, serviceID, externalID)
}

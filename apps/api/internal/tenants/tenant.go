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
	// ErrMediaPlaneNotPermitted is a write of a default plane that only an operator may set.
	ErrMediaPlaneNotPermitted = errors.New("tenant media plane not permitted")
)

type RecordingRenderMode string

const (
	RecordingRenderOnDemand  RecordingRenderMode = "on_demand"
	RecordingRenderAutomatic RecordingRenderMode = "automatic"
)

type Tenant struct {
	ID                 utilities.ID
	Name               string
	CreatedByServiceID *string
	ExternalID         *string

	DefaultMediaPlane *string
	// DefaultMediaPlaneApproved is true when an operator wrote DefaultMediaPlane. Any other
	// writer, including the previous release, leaves it false, and an unapproved value
	// never selects the own SFU.
	DefaultMediaPlaneApproved bool
	MediaPlaneProviderConfig  json.RawMessage
	StorageProviderConfig     json.RawMessage
	CORSAllowedOrigins        []string
	LogoKey                   *string
	Website                   *string
	RecordingRenderMode       RecordingRenderMode
	ArtifactPolicy            artifactpolicy.TenantPolicy
	UpdatedAt                 time.Time
	CreatedAt                 time.Time
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

	DefaultMediaPlane utilities.OptionalString
	// DefaultMediaPlaneApproved is stored with DefaultMediaPlane whenever that is set. Only
	// SetDefaultMediaPlane sets it, so every public write clears the approval.
	DefaultMediaPlaneApproved bool
	MediaPlaneProviderConfig  utilities.OptionalJSON
	StorageProviderConfig     utilities.OptionalJSON
	CORSAllowedOrigins        OptionalCORSOrigins
	LogoKey                   utilities.OptionalString
	Website                   utilities.OptionalString
	RecordingRenderMode       utilities.OptionalString
	ArtifactPolicy            ArtifactPolicyUpdate
}

type ArtifactPolicyUpdate struct {
	TranscriptLanguage               artifactpolicy.OptionalTranscriptLanguage
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

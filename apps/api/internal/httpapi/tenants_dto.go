package httpapi

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type tenantResponse struct {
	TranscriptLanguage  string                      `json:"transcript_language"`
	RecordingRenderMode tenants.RecordingRenderMode `json:"recording_render_mode"`
	ID                  string                      `json:"id"`
	Name                string                      `json:"name"`
	ExternalID          *string                     `json:"external_id"`

	DefaultMediaPlane                *string                          `json:"default_media_plane"`
	MediaPlaneProviderConfig         any                              `json:"media_plane_provider_config"`
	StorageProviderConfig            any                              `json:"storage_provider_config"`
	CORSAllowedOrigins               []string                         `json:"cors_allowed_origins"`
	LogoKey                          *string                          `json:"logo_key"`
	Website                          *string                          `json:"website"`
	TranscriptionCeiling             artifactpolicy.TranscriptionMode `json:"transcription_ceiling"`
	TranscriptionDefaultMode         artifactpolicy.TranscriptionMode `json:"transcription_default_mode"`
	ProviderPolicyVersion            string                           `json:"provider_policy_version"`
	RecordingRetentionSeconds        int64                            `json:"recording_retention_seconds"`
	TranscriptRetentionSeconds       int64                            `json:"transcript_retention_seconds"`
	TranscriptionSourceWindowSeconds int64                            `json:"transcription_source_window_seconds"`
	UpdatedAt                        string                           `json:"updated_at"`
	CreatedAt                        string                           `json:"created_at"`
}

type tenantListResponse struct {
	Tenants    []tenantResponse   `json:"tenants"`
	Pagination paginationResponse `json:"pagination"`
}

type createTenantRequest struct {
	Name       string  `json:"name"`
	ExternalID *string `json:"external_id"`

	DefaultMediaPlane        *string         `json:"default_media_plane"`
	MediaPlaneProviderConfig json.RawMessage `json:"media_plane_provider_config"`
	StorageProviderConfig    json.RawMessage `json:"storage_provider_config"`
	CORSAllowedOrigins       []string        `json:"cors_allowed_origins,omitempty"`
	LogoKey                  *string         `json:"logo_key"`
	Website                  *string         `json:"website"`
}

type updateTenantRequest struct {
	TranscriptLanguage  artifactpolicy.OptionalTranscriptLanguage `json:"transcript_language"`
	RecordingRenderMode utilities.OptionalString                  `json:"recording_render_mode"`
	Name                utilities.OptionalString                  `json:"name"`

	DefaultMediaPlane                utilities.OptionalString    `json:"default_media_plane"`
	MediaPlaneProviderConfig         utilities.OptionalJSON      `json:"media_plane_provider_config"`
	StorageProviderConfig            utilities.OptionalJSON      `json:"storage_provider_config"`
	CORSAllowedOrigins               tenants.OptionalCORSOrigins `json:"cors_allowed_origins"`
	LogoKey                          utilities.OptionalString    `json:"logo_key"`
	Website                          utilities.OptionalString    `json:"website"`
	TranscriptionCeiling             utilities.OptionalString    `json:"transcription_ceiling"`
	TranscriptionDefaultMode         utilities.OptionalString    `json:"transcription_default_mode"`
	ProviderPolicyVersion            utilities.OptionalString    `json:"provider_policy_version"`
	RecordingRetentionSeconds        tenants.OptionalInt64       `json:"recording_retention_seconds"`
	TranscriptRetentionSeconds       tenants.OptionalInt64       `json:"transcript_retention_seconds"`
	TranscriptionSourceWindowSeconds tenants.OptionalInt64       `json:"transcription_source_window_seconds"`
}

type listTenantsRequest struct {
	Page pagination.PageRequest
}

type getTenantRequest struct {
	TenantID utilities.ID
}

type updateTenantEndpointRequest struct {
	TenantID utilities.ID
	Body     updateTenantRequest
}

func newTenantListResponse(list tenants.TenantList) (tenantListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return tenantListResponse{}, err
	}

	response := tenantListResponse{
		Tenants:    make([]tenantResponse, 0, len(list.Tenants)),
		Pagination: page,
	}
	for _, tenant := range list.Tenants {
		response.Tenants = append(response.Tenants, newTenantResponse(tenant))
	}

	return response, nil
}

func newTenantResponse(tenant tenants.Tenant) tenantResponse {
	return tenantResponse{
		RecordingRenderMode: tenant.RecordingRenderMode,
		ID:                  tenant.ID.String(),
		Name:                tenant.Name,
		ExternalID:          tenant.ExternalID,

		DefaultMediaPlane:                tenant.DefaultMediaPlane,
		MediaPlaneProviderConfig:         utilities.RedactJSONSecrets(tenant.MediaPlaneProviderConfig),
		StorageProviderConfig:            utilities.RedactJSONSecrets(tenant.StorageProviderConfig),
		CORSAllowedOrigins:               append(make([]string, 0, len(tenant.CORSAllowedOrigins)), tenant.CORSAllowedOrigins...),
		LogoKey:                          tenant.LogoKey,
		Website:                          tenant.Website,
		TranscriptionCeiling:             tenant.ArtifactPolicy.TranscriptionCeiling,
		TranscriptionDefaultMode:         tenant.ArtifactPolicy.TranscriptionDefault,
		TranscriptLanguage:               tenant.ArtifactPolicy.TranscriptLanguage.String(),
		ProviderPolicyVersion:            tenant.ArtifactPolicy.ProviderPolicyVersion,
		RecordingRetentionSeconds:        int64(tenant.ArtifactPolicy.RecordingRetention / time.Second),
		TranscriptRetentionSeconds:       int64(tenant.ArtifactPolicy.TranscriptRetention / time.Second),
		TranscriptionSourceWindowSeconds: int64(tenant.ArtifactPolicy.TranscriptionSourceWindow / time.Second),
		UpdatedAt:                        utilities.FormatTimestamp(tenant.UpdatedAt),
		CreatedAt:                        utilities.FormatTimestamp(tenant.CreatedAt),
	}
}

func (r createTenantRequest) input() tenants.CreateTenantInput {
	return tenants.CreateTenantInput{
		Name: r.Name,

		DefaultMediaPlane:        r.DefaultMediaPlane,
		MediaPlaneProviderConfig: r.MediaPlaneProviderConfig,
		StorageProviderConfig:    r.StorageProviderConfig,
		CORSAllowedOrigins:       r.CORSAllowedOrigins,
		LogoKey:                  r.LogoKey,
		Website:                  r.Website,
	}
}

func (r updateTenantRequest) input() tenants.UpdateTenantInput {
	return tenants.UpdateTenantInput{
		RecordingRenderMode: r.RecordingRenderMode,
		Name:                r.Name,

		DefaultMediaPlane:        r.DefaultMediaPlane,
		MediaPlaneProviderConfig: r.MediaPlaneProviderConfig,
		StorageProviderConfig:    r.StorageProviderConfig,
		CORSAllowedOrigins:       r.CORSAllowedOrigins,
		LogoKey:                  r.LogoKey,
		Website:                  r.Website,
		ArtifactPolicy: tenants.ArtifactPolicyUpdate{
			TranscriptionCeiling:             r.TranscriptionCeiling,
			TranscriptionDefaultMode:         r.TranscriptionDefaultMode,
			TranscriptLanguage:               r.TranscriptLanguage,
			ProviderPolicyVersion:            r.ProviderPolicyVersion,
			RecordingRetentionSeconds:        r.RecordingRetentionSeconds,
			TranscriptRetentionSeconds:       r.TranscriptRetentionSeconds,
			TranscriptionSourceWindowSeconds: r.TranscriptionSourceWindowSeconds,
		},
	}
}

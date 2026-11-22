package httpapi

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func newTenantResponse(tenant tenants.Tenant) tenantResponse {
	var defaultPlane *string
	if tenant.DefaultMediaPlane != nil {
		plane := mediaplane.ProviderChalkSFU.SettingName()
		defaultPlane = &plane
	}
	return tenantResponse{
		RecordingRenderMode: tenant.RecordingRenderMode,
		ID:                  tenant.ID.String(),
		Name:                tenant.Name,
		ExternalID:          tenant.ExternalID,

		DefaultMediaPlane:                defaultPlane,
		MediaPlaneProviderConfig:         publicTenantMediaConfig(tenant.MediaPlaneProviderConfig),
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

// A Tenant can still store the retired provider document for rollback. Expose
// only its enabled setting and the current plane, never the old credentials.
func publicTenantMediaConfig(raw json.RawMessage) *mediaplane.TenantConfig {
	config, err := mediaplane.ParseTenantConfig(raw)
	if err != nil {
		return nil
	}
	config.Provider = mediaplane.ProviderChalkSFU.SettingName()
	config.Mode = mediaplane.ModeChalkManaged
	return &config
}

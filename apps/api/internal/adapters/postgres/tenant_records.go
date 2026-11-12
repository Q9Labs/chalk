package postgres

import (
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func listTenantsParams(page pagination.PageRequest) sqlc.ListTenantsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantsParams{
		PageSize: int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = pgtype.UUID{Bytes: cursor.ID.Bytes(), Valid: true}
	return params
}

func mapTenant(tenant tenantRecord) tenants.Tenant {
	policy := tenantArtifactPolicy(tenant)
	return tenants.Tenant{
		ID:                 utilities.IDFromBytes(tenant.ID.Bytes),
		Name:               tenant.Name,
		CreatedByServiceID: nullableText(tenant.CreatedByServiceID),
		ExternalID:         nullableText(tenant.ExternalID),

		DefaultMediaPlane:         nullableText(tenant.DefaultMediaPlane),
		DefaultMediaPlaneApproved: tenant.DefaultMediaPlaneApproved,
		MediaPlaneProviderConfig:  jsonRaw(tenant.MediaPlaneProviderConfig),
		StorageProviderConfig:     jsonRaw(tenant.StorageProviderConfig),
		CORSAllowedOrigins:        append([]string(nil), tenant.CorsAllowedOrigins...),
		LogoKey:                   nullableText(tenant.LogoKey),
		Website:                   nullableText(tenant.Website),
		RecordingRenderMode:       tenants.RecordingRenderMode(tenant.RecordingRenderMode),
		ArtifactPolicy:            policy,
		UpdatedAt:                 timestamp(tenant.UpdatedAt),
		CreatedAt:                 timestamp(tenant.CreatedAt),
	}
}

type tenantRecord struct {
	ID                 pgtype.UUID
	Name               string
	CreatedByServiceID pgtype.Text
	ExternalID         pgtype.Text

	DefaultMediaPlane          pgtype.Text
	DefaultMediaPlaneApproved  bool
	MediaPlaneProviderConfig   []byte
	StorageProviderConfig      []byte
	CorsAllowedOrigins         []string
	LogoKey                    pgtype.Text
	RecordingRenderMode        string
	Website                    pgtype.Text
	UpdatedAt                  pgtype.Timestamptz
	CreatedAt                  pgtype.Timestamptz
	TranscriptionCeiling       string
	TranscriptionDefaultMode   string
	TranscriptLanguage         string
	ProviderPolicyVersion      string
	RecordingRetentionSeconds  int64
	TranscriptRetentionSeconds int64
	SourceWindowSeconds        int64
}

func tenantArtifactPolicy(tenant tenantRecord) artifactpolicy.TenantPolicy {
	ceiling := artifactpolicy.TranscriptionMode(tenant.TranscriptionCeiling)
	if ceiling == "" {
		ceiling = artifactpolicy.TranscriptionDisabled
	}
	defaultMode := artifactpolicy.TranscriptionMode(tenant.TranscriptionDefaultMode)
	if defaultMode == "" {
		defaultMode = artifactpolicy.TranscriptionDisabled
	}
	return artifactpolicy.TenantPolicy{
		TranscriptionCeiling:      ceiling,
		TranscriptionDefault:      defaultMode,
		TranscriptLanguage:        storedTranscriptLanguage(tenant.TranscriptLanguage),
		ProviderPolicyVersion:     tenant.ProviderPolicyVersion,
		RecordingRetention:        time.Duration(tenant.RecordingRetentionSeconds) * time.Second,
		TranscriptRetention:       time.Duration(tenant.TranscriptRetentionSeconds) * time.Second,
		TranscriptionSourceWindow: time.Duration(tenant.SourceWindowSeconds) * time.Second,
	}
}

func createTenantRecord(row sqlc.CreateTenantRow) tenantRecord {
	return tenantRecord{
		ID:                 row.ID,
		Name:               row.Name,
		CreatedByServiceID: row.CreatedByServiceID,
		ExternalID:         row.ExternalID,

		DefaultMediaPlane:          row.DefaultMediaPlane,
		DefaultMediaPlaneApproved:  row.DefaultMediaPlaneApproved,
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
		TranscriptLanguage:         row.TranscriptLanguage,
		ProviderPolicyVersion:      row.ProviderPolicyVersion,
		RecordingRetentionSeconds:  row.RecordingRetentionSeconds,
		TranscriptRetentionSeconds: row.TranscriptRetentionSeconds,
		SourceWindowSeconds:        row.SourceWindowSeconds,
		UpdatedAt:                  row.UpdatedAt,
		CreatedAt:                  row.CreatedAt,
	}
}

func getTenantRecord(row sqlc.GetTenantRow) tenantRecord {
	return tenantRecord{
		ID:                 row.ID,
		Name:               row.Name,
		CreatedByServiceID: row.CreatedByServiceID,
		ExternalID:         row.ExternalID,

		DefaultMediaPlane:          row.DefaultMediaPlane,
		DefaultMediaPlaneApproved:  row.DefaultMediaPlaneApproved,
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
		TranscriptLanguage:         row.TranscriptLanguage,
		ProviderPolicyVersion:      row.ProviderPolicyVersion,
		RecordingRetentionSeconds:  row.RecordingRetentionSeconds,
		TranscriptRetentionSeconds: row.TranscriptRetentionSeconds,
		SourceWindowSeconds:        row.SourceWindowSeconds,
		UpdatedAt:                  row.UpdatedAt,
		CreatedAt:                  row.CreatedAt,
	}
}

func listTenantRecord(row sqlc.ListTenantsRow) tenantRecord {
	return tenantRecord{
		ID:                 row.ID,
		Name:               row.Name,
		CreatedByServiceID: row.CreatedByServiceID,
		ExternalID:         row.ExternalID,

		DefaultMediaPlane:          row.DefaultMediaPlane,
		DefaultMediaPlaneApproved:  row.DefaultMediaPlaneApproved,
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
		TranscriptLanguage:         row.TranscriptLanguage,
		ProviderPolicyVersion:      row.ProviderPolicyVersion,
		RecordingRetentionSeconds:  row.RecordingRetentionSeconds,
		TranscriptRetentionSeconds: row.TranscriptRetentionSeconds,
		SourceWindowSeconds:        row.SourceWindowSeconds,
		UpdatedAt:                  row.UpdatedAt,
		CreatedAt:                  row.CreatedAt,
	}
}

func updateTenantRecord(row sqlc.UpdateTenantRow) tenantRecord {
	return tenantRecord{
		ID:                 row.ID,
		Name:               row.Name,
		CreatedByServiceID: row.CreatedByServiceID,
		ExternalID:         row.ExternalID,

		DefaultMediaPlane:          row.DefaultMediaPlane,
		DefaultMediaPlaneApproved:  row.DefaultMediaPlaneApproved,
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
		TranscriptLanguage:         row.TranscriptLanguage,
		ProviderPolicyVersion:      row.ProviderPolicyVersion,
		RecordingRetentionSeconds:  row.RecordingRetentionSeconds,
		TranscriptRetentionSeconds: row.TranscriptRetentionSeconds,
		SourceWindowSeconds:        row.SourceWindowSeconds,
		UpdatedAt:                  row.UpdatedAt,
		CreatedAt:                  row.CreatedAt,
	}
}

func optionalTenantInt8(value tenants.OptionalInt64) pgtype.Int8 {
	if !value.Set || value.Value == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *value.Value, Valid: true}
}

func artifactPolicyMutationError(err error) error {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return nil
	}
	switch postgresError.ConstraintName {
	case "tenant_artifact_policies_default_ceiling_check":
		return artifactpolicy.ErrDefaultExceedsCeiling
	case "tenant_artifact_policies_ceiling_check", "tenant_artifact_policies_default_check":
		return artifactpolicy.ErrInvalidTranscriptionMode
	case "tenant_artifact_policies_recording_retention_check", "tenant_artifact_policies_transcript_retention_check":
		return artifactpolicy.ErrInvalidRetention
	case "tenant_artifact_policies_source_window_check":
		return artifactpolicy.ErrInvalidSourceWindow
	case "tenant_artifact_policies_provider_policy_check":
		return artifactpolicy.ErrMissingProviderPolicy
	default:
		return nil
	}
}

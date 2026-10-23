package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TenantRepository struct {
	queries tenantQuerier
}

type tenantQuerier interface {
	FindServiceTenantID(context.Context, sqlc.FindServiceTenantIDParams) (pgtype.UUID, error)
	CreateTenant(ctx context.Context, arg sqlc.CreateTenantParams) (sqlc.CreateTenantRow, error)
	GetTenant(ctx context.Context, id pgtype.UUID) (sqlc.GetTenantRow, error)
	GetTenantCORSAllowedOrigins(ctx context.Context, id pgtype.UUID) ([]string, error)
	ListTenants(ctx context.Context, arg sqlc.ListTenantsParams) ([]sqlc.ListTenantsRow, error)
	UpdateTenant(ctx context.Context, arg sqlc.UpdateTenantParams) (sqlc.UpdateTenantRow, error)
}

func NewTenantRepository(queries tenantQuerier) TenantRepository {
	return TenantRepository{queries: queries}
}

func (s TenantRepository) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	tenant, err := s.queries.CreateTenant(ctx, sqlc.CreateTenantParams{
		ID:                 pgtype.UUID{Bytes: input.ID.Bytes(), Valid: true},
		Name:               input.Name,
		CreatedByServiceID: text(input.CreatedByServiceID),
		ExternalID:         text(input.ExternalID),

		DefaultMediaPlane:        text(input.DefaultMediaPlane),
		MediaPlaneProviderConfig: jsonBytes(input.MediaPlaneProviderConfig),
		StorageProviderConfig:    jsonBytes(input.StorageProviderConfig),
		CorsAllowedOrigins:       input.CORSAllowedOrigins,
		LogoKey:                  text(input.LogoKey),
		Website:                  text(input.Website),
	})
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("create tenant: %w", err)
	}

	return mapTenant(createTenantRecord(tenant)), nil
}

func (s TenantRepository) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	tenant, err := s.queries.GetTenant(ctx, pgtype.UUID{Bytes: id.Bytes(), Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("get tenant: %w", err)
	}

	return mapTenant(getTenantRecord(tenant)), nil
}

func (s TenantRepository) GetTenantCORSAllowedOrigins(ctx context.Context, id utilities.ID) ([]string, error) {
	origins, err := s.queries.GetTenantCORSAllowedOrigins(ctx, uuid(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, tenants.ErrTenantNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get tenant CORS allowed origins: %w", err)
	}
	return origins, nil
}

func (s TenantRepository) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	return s.listTenants(ctx, page, nil)
}

func (s TenantRepository) ListServiceTenants(ctx context.Context, serviceID string, page pagination.PageRequest) (tenants.TenantList, error) {
	return s.listTenants(ctx, page, &serviceID)
}

func (s TenantRepository) listTenants(ctx context.Context, page pagination.PageRequest, serviceID *string) (tenants.TenantList, error) {
	params := listTenantsParams(page)
	params.ServiceID = text(serviceID)
	rows, err := s.queries.ListTenants(ctx, params)
	if err != nil {
		return tenants.TenantList{}, fmt.Errorf("list tenants: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	response := tenants.TenantList{
		Tenants: make([]tenants.Tenant, 0, len(rows)),
		Page: pagination.Page{
			PageSize: size,
			HasMore:  hasMore,
		},
	}
	for _, row := range rows {
		response.Tenants = append(response.Tenants, mapTenant(listTenantRecord(row)))
	}

	if hasMore && len(response.Tenants) > 0 {
		lastTenant := response.Tenants[len(response.Tenants)-1]
		response.Page.NextCursor = &pagination.Cursor{
			CreatedAt: lastTenant.CreatedAt,
			ID:        lastTenant.ID,
		}
	}

	return response, nil
}

func (s TenantRepository) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	tenant, err := s.queries.UpdateTenant(ctx, sqlc.UpdateTenantParams{
		ID:                     pgtype.UUID{Bytes: id.Bytes(), Valid: true},
		RecordingRenderModeSet: input.RecordingRenderMode.Set,
		RecordingRenderMode:    requiredText(input.RecordingRenderMode),
		NameSet:                input.Name.Set,
		Name:                   requiredText(input.Name),

		DefaultMediaPlaneSet:          input.DefaultMediaPlane.Set,
		DefaultMediaPlane:             text(input.DefaultMediaPlane.Value),
		MediaPlaneProviderConfigSet:   input.MediaPlaneProviderConfig.Set,
		MediaPlaneProviderConfig:      jsonBytes(input.MediaPlaneProviderConfig.Value),
		StorageProviderConfigSet:      input.StorageProviderConfig.Set,
		StorageProviderConfig:         jsonBytes(input.StorageProviderConfig.Value),
		CorsAllowedOriginsSet:         input.CORSAllowedOrigins.Set,
		CorsAllowedOrigins:            input.CORSAllowedOrigins.Value,
		LogoKeySet:                    input.LogoKey.Set,
		LogoKey:                       text(input.LogoKey.Value),
		WebsiteSet:                    input.Website.Set,
		Website:                       text(input.Website.Value),
		TranscriptionCeilingSet:       input.ArtifactPolicy.TranscriptionCeiling.Set,
		TranscriptionCeiling:          requiredText(input.ArtifactPolicy.TranscriptionCeiling),
		TranscriptionDefaultModeSet:   input.ArtifactPolicy.TranscriptionDefaultMode.Set,
		TranscriptionDefaultMode:      requiredText(input.ArtifactPolicy.TranscriptionDefaultMode),
		ProviderPolicyVersionSet:      input.ArtifactPolicy.ProviderPolicyVersion.Set,
		ProviderPolicyVersion:         text(input.ArtifactPolicy.ProviderPolicyVersion.Value),
		RecordingRetentionSecondsSet:  input.ArtifactPolicy.RecordingRetentionSeconds.Set,
		RecordingRetentionSeconds:     optionalTenantInt8(input.ArtifactPolicy.RecordingRetentionSeconds),
		TranscriptRetentionSecondsSet: input.ArtifactPolicy.TranscriptRetentionSeconds.Set,
		TranscriptRetentionSeconds:    optionalTenantInt8(input.ArtifactPolicy.TranscriptRetentionSeconds),
		SourceWindowSecondsSet:        input.ArtifactPolicy.TranscriptionSourceWindowSeconds.Set,
		SourceWindowSeconds:           optionalTenantInt8(input.ArtifactPolicy.TranscriptionSourceWindowSeconds),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		if policyErr := artifactPolicyMutationError(err); policyErr != nil {
			return tenants.Tenant{}, policyErr
		}
		return tenants.Tenant{}, fmt.Errorf("update tenant: %w", err)
	}

	return mapTenant(updateTenantRecord(tenant)), nil
}

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

		DefaultMediaPlane:        nullableText(tenant.DefaultMediaPlane),
		MediaPlaneProviderConfig: jsonRaw(tenant.MediaPlaneProviderConfig),
		StorageProviderConfig:    jsonRaw(tenant.StorageProviderConfig),
		CORSAllowedOrigins:       append([]string(nil), tenant.CorsAllowedOrigins...),
		LogoKey:                  nullableText(tenant.LogoKey),
		Website:                  nullableText(tenant.Website),
		RecordingRenderMode:      tenants.RecordingRenderMode(tenant.RecordingRenderMode),
		ArtifactPolicy:           policy,
		UpdatedAt:                timestamp(tenant.UpdatedAt),
		CreatedAt:                timestamp(tenant.CreatedAt),
	}
}

type tenantRecord struct {
	ID                 pgtype.UUID
	Name               string
	CreatedByServiceID pgtype.Text
	ExternalID         pgtype.Text

	DefaultMediaPlane          pgtype.Text
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
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
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
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
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
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
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
		MediaPlaneProviderConfig:   row.MediaPlaneProviderConfig,
		StorageProviderConfig:      row.StorageProviderConfig,
		CorsAllowedOrigins:         row.CorsAllowedOrigins,
		LogoKey:                    row.LogoKey,
		RecordingRenderMode:        row.RecordingRenderMode,
		Website:                    row.Website,
		TranscriptionCeiling:       row.TranscriptionCeiling,
		TranscriptionDefaultMode:   row.TranscriptionDefaultMode,
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

var _ tenants.TenantRepository = TenantRepository{}

func (s TenantRepository) FindServiceTenant(ctx context.Context, serviceID, externalID string) (tenants.Tenant, error) {
	id, err := s.queries.FindServiceTenantID(ctx, sqlc.FindServiceTenantIDParams{ServiceID: pgtype.Text{String: serviceID, Valid: true}, ExternalID: pgtype.Text{String: externalID, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("find service Tenant: %w", err)
	}
	return s.GetTenant(ctx, utilities.IDFromBytes(id.Bytes))
}

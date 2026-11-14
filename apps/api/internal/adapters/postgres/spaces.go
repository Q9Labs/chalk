package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type SpaceRepository struct {
	queries spaceQuerier
	pool    *pgxpool.Pool
}

type spaceQuerier interface {
	CreateSpace(ctx context.Context, arg sqlc.CreateSpaceParams) (sqlc.CreateSpaceRow, error)
	ListSpaceRoles(ctx context.Context, arg sqlc.ListSpaceRolesParams) ([]sqlc.SpaceRole, error)
	GetTenantSpace(ctx context.Context, arg sqlc.GetTenantSpaceParams) (sqlc.Space, error)
	ListTenantSpaces(ctx context.Context, arg sqlc.ListTenantSpacesParams) ([]sqlc.Space, error)
	ListTenantSpacesByActivity(ctx context.Context, arg sqlc.ListTenantSpacesByActivityParams) ([]sqlc.ListTenantSpacesByActivityRow, error)
	UpdateTenantSpace(ctx context.Context, arg sqlc.UpdateTenantSpaceParams) (sqlc.Space, error)
	ArchiveTenantSpace(ctx context.Context, arg sqlc.ArchiveTenantSpaceParams) (sqlc.Space, error)
	RestoreTenantSpace(ctx context.Context, arg sqlc.RestoreTenantSpaceParams) (sqlc.Space, error)
	AdoptSpaceMediaPlaneSetting(ctx context.Context, arg sqlc.AdoptSpaceMediaPlaneSettingParams) (int64, error)
}

func NewSpaceRepository(queries spaceQuerier, pools ...*pgxpool.Pool) SpaceRepository {
	var pool *pgxpool.Pool
	if len(pools) > 0 {
		pool = pools[0]
	}
	return SpaceRepository{queries: queries, pool: pool}
}

func (r SpaceRepository) CreateSpace(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	if r.pool != nil {
		return r.createSpaceWithWebhook(ctx, input)
	}

	space, err := r.queries.CreateSpace(ctx, createSpaceParams(input))
	if err != nil {
		if uniqueConstraintViolation(err, "spaces_tenant_id_slug_key") {
			return spaces.Space{}, spaces.ErrSpaceSlugAlreadyUsed
		}
		return spaces.Space{}, fmt.Errorf("create space: %w", err)
	}

	return r.withSpaceRoles(ctx, mapCreatedSpace(space))
}

// CreateSpaceIdempotent persists the request reservation and Space in the
// same transaction. Replays return the original resource metadata and never
// emit a second space.created webhook.
func (r SpaceRepository) CreateSpaceIdempotent(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	if r.pool == nil {
		return spaces.Space{}, errors.New("space idempotency requires a postgres pool")
	}
	return r.createSpaceWithWebhook(ctx, input)
}

func (r SpaceRepository) GetSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	space, err := r.queries.GetTenantSpace(ctx, sqlc.GetTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, fmt.Errorf("get space: %w", err)
	}

	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (spaces.SpaceList, error) {
	return r.ListSpacesFiltered(ctx, tenantID, page, spaces.ListOptions{})
}

func (r SpaceRepository) ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, options spaces.ListOptions) (spaces.SpaceList, error) {
	// Each row comes with the time its order sorts by, which a next page's cursor carries.
	var rows []spaceListRow
	if options.Order == spaces.ListOrderActive {
		found, err := r.queries.ListTenantSpacesByActivity(ctx, listTenantSpacesByActivityParams(tenantID, page, options.Archived))
		if err != nil {
			return spaces.SpaceList{}, fmt.Errorf("list spaces by activity: %w", err)
		}
		for _, row := range found {
			rows = append(rows, spaceListRow{space: row.Space, sortedAt: row.ActiveAt.Time})
		}
	} else {
		found, err := r.queries.ListTenantSpaces(ctx, listTenantSpacesParams(tenantID, page, options.Archived))
		if err != nil {
			return spaces.SpaceList{}, fmt.Errorf("list spaces: %w", err)
		}
		for _, row := range found {
			rows = append(rows, spaceListRow{space: row, sortedAt: row.CreatedAt.Time})
		}
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := spaces.SpaceList{
		Spaces: make([]spaces.Space, 0, len(rows)),
		Page:   pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		space, err := r.withSpaceRoles(ctx, mapSpace(row.space))
		if err != nil {
			return spaces.SpaceList{}, err
		}
		list.Spaces = append(list.Spaces, space)
	}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.sortedAt, ID: utilities.IDFromBytes(last.space.ID.Bytes)}
	}

	return list, nil
}

type spaceListRow struct {
	space    sqlc.Space
	sortedAt time.Time
}

func (r SpaceRepository) UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input spaces.UpdateSpaceInput) (spaces.Space, error) {
	if r.pool != nil {
		return r.updateSpaceWithWebhook(ctx, tenantID, spaceID, input)
	}

	space, err := r.queries.UpdateTenantSpace(ctx, sqlc.UpdateTenantSpaceParams{
		TenantID:                         uuid(tenantID),
		ID:                               uuid(spaceID),
		NameSet:                          input.Name.Set,
		Name:                             requiredText(input.Name),
		SlugSet:                          input.Slug.Set,
		Slug:                             requiredText(input.Slug),
		MediaPlaneSet:                    input.MediaPlane.Set,
		MediaPlane:                       requiredText(input.MediaPlane),
		MediaPlaneSettingSet:             input.MediaPlaneSetting.Set,
		MediaPlaneSetting:                optionalPlaneSetting(input.MediaPlaneSetting),
		MetadataSet:                      input.Metadata.Set,
		Metadata:                         jsonBytes(input.Metadata.Value),
		RecurringPolicySet:               input.RecurringPolicy.Set,
		RecurringPolicy:                  jsonBytes(input.RecurringPolicy.Value),
		AdmissionPolicySet:               input.AdmissionPolicy.Set,
		AdmissionPolicy:                  jsonBytes(input.AdmissionPolicy.Value),
		DefaultEpisodeDurationSecondsSet: input.DefaultEpisodeDurationSeconds.Set,
		DefaultEpisodeDurationSeconds:    optionalInt32(input.DefaultEpisodeDurationSeconds),
		MaximumEpisodeDurationSecondsSet: input.MaximumEpisodeDurationSeconds.Set,
		MaximumEpisodeDurationSeconds:    optionalInt32(input.MaximumEpisodeDurationSeconds),
		LingerWindowSecondsSet:           input.LingerWindowSeconds.Set,
		LingerWindowSeconds:              optionalInt32(input.LingerWindowSeconds),
		RecordingPolicySet:               input.RecordingPolicy.Set,
		RecordingPolicy:                  optionalRecordingPolicy(input.RecordingPolicy),
		TranscriptionPolicySet:           input.TranscriptionPolicy.Set,
		TranscriptLanguageSet:            input.TranscriptLanguage.Set,
		TranscriptLanguage:               text(optionalLanguageString(input.TranscriptLanguage.Value)),
		TranscriptionPolicy:              optionalTranscriptionPolicy(input.TranscriptionPolicy),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		if uniqueConstraintViolation(err, "spaces_tenant_id_slug_key") {
			return spaces.Space{}, spaces.ErrSpaceSlugAlreadyUsed
		}
		return spaces.Space{}, fmt.Errorf("update space: %w", err)
	}

	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) ArchiveSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	if r.pool != nil {
		return r.archiveSpaceWithWebhook(ctx, tenantID, spaceID)
	}
	space, err := r.queries.ArchiveTenantSpace(ctx, sqlc.ArchiveTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, fmt.Errorf("archive space: %w", err)
	}
	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) RestoreSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	if r.pool != nil {
		return r.restoreSpaceWithWebhook(ctx, tenantID, spaceID)
	}
	space, err := r.queries.RestoreTenantSpace(ctx, sqlc.RestoreTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, fmt.Errorf("restore space: %w", err)
	}
	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) withSpaceRoles(ctx context.Context, space spaces.Space) (spaces.Space, error) {
	roles, err := r.queries.ListSpaceRoles(ctx, sqlc.ListSpaceRolesParams{TenantID: uuid(space.TenantID), SpaceID: uuid(space.ID)})
	if err != nil {
		return spaces.Space{}, fmt.Errorf("list space roles: %w", err)
	}
	space.Roles = make([]spaces.Role, 0, len(roles))
	for _, role := range roles {
		space.Roles = append(space.Roles, mapSpaceRole(role))
	}
	return space, nil
}

func createSpaceParams(input spaces.CreateSpaceInput) sqlc.CreateSpaceParams {
	return sqlc.CreateSpaceParams{
		ID:                            uuid(input.ID),
		PublicInviteHandle:            append([]byte(nil), input.PublicInviteHandle[:]...),
		Name:                          input.Name,
		TenantID:                      uuid(input.TenantID),
		Slug:                          input.Slug,
		MediaPlane:                    input.MediaPlane,
		MediaPlaneSetting:             optionalPlaneSetting(spaces.OptionalMediaPlaneSetting{Set: true, Value: input.MediaPlaneSetting}),
		Metadata:                      jsonBytes(input.Metadata),
		RecurringPolicy:               jsonBytes(input.RecurringPolicy),
		AdmissionPolicy:               jsonBytes(input.AdmissionPolicy),
		RecordingPolicy:               policyText(string(input.RecordingPolicy), input.RecordingPolicySet),
		TranscriptionPolicy:           policyText(string(input.TranscriptionPolicy), input.TranscriptionPolicySet),
		TranscriptLanguage:            text(optionalLanguageString(input.TranscriptLanguage)),
		DefaultEpisodeDurationSeconds: input.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: input.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           input.LingerWindowSeconds,
		CreatedByUserID:               uuid(input.CreatedByUserID),
	}
}

func listTenantSpacesParams(tenantID utilities.ID, page pagination.PageRequest, archived *bool) sqlc.ListTenantSpacesParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantSpacesParams{
		TenantID: uuid(tenantID),
		PageSize: int32(page.Size() + 1),
	}
	if archived != nil {
		params.ArchivedSet = true
		params.Archived = *archived
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = uuid(cursor.ID)
	return params
}

func listTenantSpacesByActivityParams(tenantID utilities.ID, page pagination.PageRequest, archived *bool) sqlc.ListTenantSpacesByActivityParams {
	params := sqlc.ListTenantSpacesByActivityParams{
		TenantID: uuid(tenantID),
		PageSize: int32(page.Size() + 1),
	}
	if archived != nil {
		params.ArchivedSet = true
		params.Archived = *archived
	}
	if cursor := page.Cursor(); cursor != nil {
		params.CursorSet = true
		params.CursorActiveAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
		params.CursorID = uuid(cursor.ID)
	}
	return params
}

func optionalInt32(value spaces.OptionalInt32) int32 {
	if value.Value == nil {
		return 0
	}
	return *value.Value
}

func optionalRecordingPolicy(value spaces.OptionalRecordingPolicy) string {
	if !value.Set || value.Value == nil {
		return ""
	}
	return string(*value.Value)
}

func optionalTranscriptionPolicy(value spaces.OptionalTranscriptionPolicy) string {
	if !value.Set || value.Value == nil {
		return ""
	}
	return string(*value.Value)
}

func policyText(value string, set bool) pgtype.Text {
	if !set {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func mapSpace(space sqlc.Space) spaces.Space {
	return spaces.Space{
		ID:                            utilities.IDFromBytes(space.ID.Bytes),
		Name:                          space.Name,
		TenantID:                      utilities.IDFromBytes(space.TenantID.Bytes),
		Slug:                          space.Slug,
		MediaPlane:                    space.MediaPlane,
		MediaPlaneSetting:             mediaPlaneSetting(space.MediaPlaneSetting),
		RecordingPolicy:               artifactpolicy.RecordingMode(space.RecordingPolicy),
		TranscriptionPolicy:           artifactpolicy.TranscriptionMode(space.TranscriptionPolicy),
		TranscriptLanguage:            nullableTranscriptLanguage(space.TranscriptLanguage),
		Metadata:                      jsonRaw(space.Metadata),
		RecurringPolicy:               jsonRaw(space.RecurringPolicy),
		AdmissionPolicy:               jsonRaw(space.AdmissionPolicy),
		DefaultEpisodeDurationSeconds: space.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: space.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           space.LingerWindowSeconds,
		ArchivedAt:                    nullableTimestamp(space.ArchivedAt),
		CreatedByUserID:               nullableID(space.CreatedByUserID),
		UpdatedAt:                     timestamp(space.UpdatedAt),
		CreatedAt:                     timestamp(space.CreatedAt),
	}
}

func mapCreatedSpace(space sqlc.CreateSpaceRow) spaces.Space {
	return spaces.Space{
		ID:                            utilities.IDFromBytes(space.ID.Bytes),
		Name:                          space.Name,
		TenantID:                      utilities.IDFromBytes(space.TenantID.Bytes),
		Slug:                          space.Slug,
		MediaPlane:                    space.MediaPlane,
		MediaPlaneSetting:             mediaPlaneSetting(space.MediaPlaneSetting),
		RecordingPolicy:               artifactpolicy.RecordingMode(space.RecordingPolicy),
		TranscriptionPolicy:           artifactpolicy.TranscriptionMode(space.TranscriptionPolicy),
		TranscriptLanguage:            nullableTranscriptLanguage(space.TranscriptLanguage),
		Metadata:                      jsonRaw(space.Metadata),
		RecurringPolicy:               jsonRaw(space.RecurringPolicy),
		AdmissionPolicy:               jsonRaw(space.AdmissionPolicy),
		DefaultEpisodeDurationSeconds: space.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: space.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           space.LingerWindowSeconds,
		ArchivedAt:                    nullableTimestamp(space.ArchivedAt),
		CreatedByUserID:               nullableID(space.CreatedByUserID),
		UpdatedAt:                     timestamp(space.UpdatedAt),
		CreatedAt:                     timestamp(space.CreatedAt),
	}
}

func mapSpaceRole(role sqlc.SpaceRole) spaces.Role {
	return spaces.Role{
		ID:           utilities.IDFromBytes(role.ID.Bytes),
		TenantID:     utilities.IDFromBytes(role.TenantID.Bytes),
		SpaceID:      utilities.IDFromBytes(role.SpaceID.Bytes),
		Name:         role.Name,
		Capabilities: append([]string(nil), role.Capabilities...),
	}
}

var _ spaces.Repository = SpaceRepository{}

func mediaPlaneSetting(value pgtype.Text) *mediaplane.Provider {
	if !value.Valid {
		return nil
	}
	provider, err := mediaplane.ParseSettingName(value.String)
	if err != nil {
		return nil
	}
	return &provider
}

func optionalPlaneSetting(input spaces.OptionalMediaPlaneSetting) pgtype.Text {
	if !input.Set || input.Value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: input.Value.SettingName(), Valid: true}
}

// AdoptStoredPlaneSetting moves a Space stored on the plane onto the setting. It reports
// false when the Space no longer qualifies: it gained a setting, stores another plane, or
// its Tenant can no longer serve the own SFU. No Space reads differently afterwards, so it
// sends no space.updated event.
func (r SpaceRepository) AdoptStoredPlaneSetting(ctx context.Context, tenantID, spaceID utilities.ID, plane mediaplane.Provider) (bool, error) {
	rows, err := r.queries.AdoptSpaceMediaPlaneSetting(ctx, sqlc.AdoptSpaceMediaPlaneSettingParams{
		Plane: plane.SettingName(), TenantID: uuid(tenantID), ID: uuid(spaceID),
	})
	if err != nil {
		return false, err
	}
	return rows == 1, nil
}
